// @polsia:user-owned — brani registrati dall'utente, ospitati interamente su Solco.
// Il file è privato (uploadPrivateFile → R2 Polsia) e qui viene solo ispezionato e
// registrato: la durata è ricavata dal server, mai dal client.
import 'server-only';
import type { Recording, RecordingChartItem } from '@/lib/contracts/recordings';
import { prisma } from '@/lib/db';
import {
  InvalidPrivateAudioSource,
  inspectRecordingSource,
  openPrivateAudioSource,
  PrivateAudioStorageUnavailable,
} from '@/lib/music/private-audio-source.server';

/** Tetto per utente: tiene a bada il consumo di archivio. */
export const MAX_RECORDINGS_PER_USER = 100;
const MAX_DURATION_SECONDS = 86_400;

export class RecordingLimitReached extends Error {
  constructor() {
    super('recording_limit_reached');
  }
}

/** Il file privato non è un audio valido o non è raggiungibile. */
export class InvalidRecordingSource extends Error {
  constructor() {
    super('invalid_recording_source');
  }
}

/** Oltre questa soglia di segnalatori DISTINTI un brano pubblicato si auto-ritira. */
export const AUTO_UNPUBLISH_REPORTS = 5;
/** Quante voci al massimo nella classifica community. */
const PUBLIC_CHART_MAX = 50;
/** Tetto al contributo di un singolo ascoltatore alla classifica community (anti-inflazione). */
const PER_LISTENER_PLAY_CAP = 20;

type RecordingRow = {
  id: string;
  title: string;
  durationSeconds: number;
  createdAt: Date;
  published: boolean;
};

const recordingSelect = {
  id: true,
  title: true,
  durationSeconds: true,
  createdAt: true,
  published: true,
} as const;

function toRecording(row: RecordingRow): Recording {
  return {
    id: row.id,
    title: row.title,
    durationSeconds: row.durationSeconds,
    createdAt: row.createdAt.toISOString(),
    published: row.published,
  };
}

export async function listRecordings(userId: string): Promise<Recording[]> {
  const rows = await prisma.userRecording.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: recordingSelect,
    take: MAX_RECORDINGS_PER_USER,
  });
  return rows.map(toRecording);
}

/** Pubblica o ritira una registrazione (solo il proprietario). Null se non è sua. */
export async function setRecordingPublished(
  userId: string,
  recordingId: string,
  published: boolean,
): Promise<Recording | null> {
  const result = await prisma.userRecording.updateMany({
    where: { id: recordingId, userId },
    data: published
      ? { published: true, publishedAt: new Date(), reports: 0 }
      : { published: false, publishedAt: null },
  });
  if (result.count === 0) return null;
  // Pubblicando si riparte da zero segnalazioni: cancella quelle precedenti.
  if (published) {
    await prisma.recordingReport.deleteMany({ where: { recordingId } });
  }
  const row = await prisma.userRecording.findFirst({
    where: { id: recordingId, userId },
    select: recordingSelect,
  });
  return row ? toRecording(row) : null;
}

/**
 * La registrazione è ascoltabile dal richiedente: se è sua OPPURE se è pubblicata.
 * Così lo stream serve i brani pubblicati agli altri utenti, ma i privati solo al proprietario.
 */
export async function getStreamableRecording(
  requesterId: string,
  recordingId: string,
): Promise<{ fileKey: string; mimeType: string; byteLength: number } | null> {
  const row = await prisma.userRecording.findUnique({
    where: { id: recordingId },
    select: { userId: true, published: true, fileKey: true, mimeType: true, byteLength: true },
  });
  if (!row) return null;
  if (row.userId !== requesterId && !row.published) return null;
  return { fileKey: row.fileKey, mimeType: row.mimeType, byteLength: row.byteLength };
}

/**
 * Segnala una registrazione pubblicata. Una segnalazione per utente (deduplica), e il conteggio
 * è di segnalatori DISTINTI: oltre la soglia il brano si auto-ritira. Ritorna true se il brano
 * pubblicato esisteva.
 */
export async function reportRecording(
  recordingId: string,
  reporterUserId: string,
): Promise<boolean> {
  const target = await prisma.userRecording.findFirst({
    where: { id: recordingId, published: true },
    select: { id: true },
  });
  if (!target) return false;

  // Una sola segnalazione per utente: se l'ha già fatta, non conta due volte.
  try {
    await prisma.recordingReport.create({ data: { recordingId, reporterUserId } });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  const distinct = await prisma.recordingReport.count({ where: { recordingId } });
  await prisma.userRecording.updateMany({
    where: { id: recordingId, published: true },
    data: { reports: distinct },
  });
  if (distinct >= AUTO_UNPUBLISH_REPORTS) {
    await prisma.userRecording.updateMany({
      where: { id: recordingId, published: true },
      data: { published: false, publishedAt: null },
    });
  }
  return true;
}

/**
 * Classifica community: i brani PUBBLICATI, ordinati per ascolti. Conta solo gli ascolti degli
 * ALTRI utenti (gli auto-ascolti del proprietario sono esclusi) e limita il contributo di un
 * singolo ascoltatore, così la classifica non è gonfiabile da soli. Solo i pubblicati.
 */
export async function listPublicRecordingsChart(): Promise<RecordingChartItem[]> {
  const published = await prisma.userRecording.findMany({
    where: { published: true },
    select: { id: true, title: true, durationSeconds: true, userId: true },
    take: 500,
  });
  if (published.length === 0) return [];

  const ownerByQualifiedId = new Map(published.map((row) => [`recording:${row.id}`, row.userId]));
  const qualifiedIds = [...ownerByQualifiedId.keys()];
  const rows = await prisma.userPlaybackHistory.findMany({
    where: { qualifiedId: { in: qualifiedIds } },
    select: { qualifiedId: true, userId: true, playCount: true },
  });

  const plays = new Map<string, number>();
  for (const row of rows) {
    // Escludi gli ascolti del proprietario (anti auto-inflazione).
    if (row.userId === ownerByQualifiedId.get(row.qualifiedId)) continue;
    const id = row.qualifiedId.slice('recording:'.length);
    const capped = Math.min(row.playCount, PER_LISTENER_PLAY_CAP);
    plays.set(id, (plays.get(id) ?? 0) + capped);
  }

  return published
    .map((row) => ({
      id: row.id,
      title: row.title,
      durationSeconds: row.durationSeconds,
      playCount: plays.get(row.id) ?? 0,
    }))
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, PUBLIC_CHART_MAX);
}

/**
 * Classifica degli ascolti locali: le registrazioni dell'utente ordinate per numero di ascolti.
 * Il conteggio viene dalla cronologia (UserPlaybackHistory) per i qualifiedId `recording:<id>`;
 * le registrazioni mai ascoltate compaiono comunque con 0.
 */
export async function listRecordingsChart(userId: string): Promise<RecordingChartItem[]> {
  const [recordings, history] = await Promise.all([
    prisma.userRecording.findMany({
      where: { userId },
      select: { id: true, title: true, durationSeconds: true, createdAt: true },
      take: MAX_RECORDINGS_PER_USER,
    }),
    prisma.userPlaybackHistory.findMany({
      where: { userId, qualifiedId: { startsWith: 'recording:' } },
      select: { qualifiedId: true, playCount: true },
    }),
  ]);

  const plays = new Map<string, number>();
  for (const row of history) {
    plays.set(row.qualifiedId.slice('recording:'.length), row.playCount);
  }

  return recordings
    .map((row) => ({
      id: row.id,
      title: row.title,
      durationSeconds: row.durationSeconds,
      playCount: plays.get(row.id) ?? 0,
      createdAt: row.createdAt.getTime(),
    }))
    .sort((a, b) => b.playCount - a.playCount || b.createdAt - a.createdAt)
    .map(({ createdAt: _createdAt, ...item }) => item);
}

/**
 * Registra una registrazione già caricata in archivio privato. Ispeziona il file
 * (conferma che è davvero audio e ne ricava la durata) prima di salvarlo.
 */
export async function registerRecording(
  userId: string,
  input: {
    title: string;
    fileKey: string;
    mimeType: string;
    byteLength: number;
    elapsedSeconds: number;
  },
): Promise<Recording> {
  const existing = await prisma.userRecording.count({ where: { userId } });
  if (existing >= MAX_RECORDINGS_PER_USER) throw new RecordingLimitReached();

  let durationSeconds: number;
  try {
    const inspected = await inspectRecordingSource(input.fileKey, input.mimeType, input.byteLength);
    // La durata autorevole è quella del contenitore; se manca (tipico dei WebM/Opus di
    // MediaRecorder) si usa quella misurata dal client.
    const seconds = inspected.durationSeconds ?? input.elapsedSeconds;
    durationSeconds = Math.min(MAX_DURATION_SECONDS, Math.max(1, Math.ceil(seconds)));
  } catch (error) {
    if (
      error instanceof InvalidPrivateAudioSource ||
      error instanceof PrivateAudioStorageUnavailable
    ) {
      throw new InvalidRecordingSource();
    }
    throw error;
  }

  try {
    const row = await prisma.userRecording.create({
      data: {
        userId,
        title: input.title,
        fileKey: input.fileKey,
        mimeType: input.mimeType,
        byteLength: input.byteLength,
        durationSeconds,
      },
      select: recordingSelect,
    });
    return toRecording(row);
  } catch (error) {
    // Chiave file già registrata (unica): trattala come sorgente non valida.
    if (isUniqueViolation(error)) throw new InvalidRecordingSource();
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

/** La riga (con la chiave privata) solo se appartiene all'utente; altrimenti null. */
export async function getOwnedRecording(
  userId: string,
  recordingId: string,
): Promise<{ fileKey: string; mimeType: string; byteLength: number } | null> {
  const row = await prisma.userRecording.findFirst({
    where: { id: recordingId, userId },
    select: { fileKey: true, mimeType: true, byteLength: true },
  });
  return row;
}

export async function deleteRecording(userId: string, recordingId: string): Promise<boolean> {
  // Si rimuove la riga del DB. L'oggetto privato in archivio resta orfano: il modulo file-upload
  // non espone una delete, e authorizeDownload nega /api/files, quindi senza una riga che lo mappi
  // l'oggetto è irraggiungibile (nessuna esposizione di dati). Il cap per-utente conta le righe, non
  // i byte, quindi cicli registra→elimina accumulano oggetti orfani: la crescita è però limitata dal
  // tetto di dimensione (40 MB) e dal rate-limit giornaliero (recordings.write). Un lavoro di pulizia
  // lato Polsia resta da fare quando il modulo esporrà una delete.
  const result = await prisma.userRecording.deleteMany({ where: { id: recordingId, userId } });
  return result.count > 0;
}

/** Apre lo stream del file privato (con eventuale Range). */
export function openRecordingStream(fileKey: string, range: string | null) {
  return openPrivateAudioSource(fileKey, range);
}
