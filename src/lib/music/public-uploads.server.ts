// @polsia:user-owned — logica server della libreria PUBBLICA di brani caricati (AWS S3).
// Il file audio è un oggetto PUBBLICO su S3: qui si registra il brano a partire dalla CHIAVE scelta
// dal server (l'URL pubblico è derivato, mai mandato dal client), si elenca la classifica, si
// moderano le segnalazioni e si rimuovono (anche l'oggetto su S3).
import 'server-only';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  MAX_PUBLIC_UPLOAD_BYTES,
  PUBLIC_UPLOAD_MAX_PER_USER,
  type PublicUpload,
  type PublicUploadCreateInput,
} from '@/lib/contracts/public-uploads';
import { prisma } from '@/lib/db';
import {
  deleteObject,
  headObject,
  isS3Configured,
  s3ObjectUrl,
} from '@/lib/music/s3-storage.server';

/** Oltre questo numero di segnalatori DISTINTI il brano si auto-ritira dalla libreria pubblica. */
export const AUTO_UNPUBLISH_REPORTS = 5;
/** Tetto di brani pubblici per utente: ognuno può pubblicare al massimo 3 brani. */
export const MAX_UPLOADS_PER_USER = PUBLIC_UPLOAD_MAX_PER_USER;
/** Prefisso obbligatorio della chiave su S3 (lo impone anche il rilascio dell'URL firmato). */
export const PUBLIC_UPLOAD_PREFIX = 'public-uploads/';

export class PublicUploadLimitReached extends Error {}
export class InvalidPublicUploadSource extends Error {}
export class StorageNotConfigured extends Error {}

/** La libreria pubblica è attiva solo se AWS S3 è configurato (regione, bucket, credenziali). */
export function isPublicUploadConfigured(): boolean {
  return isS3Configured();
}

/** Quanti brani pubblici ha già l'utente (per far rispettare il tetto già al rilascio dell'URL). */
export function countUserPublicUploads(userId: string): Promise<number> {
  return prisma.publicUpload.count({ where: { uploaderUserId: userId } });
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/webm': 'weba',
};

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'brano'
  );
}

function extensionFor(contentType: string, fileName: string): string {
  const byType = EXT_BY_CONTENT_TYPE[contentType];
  if (byType) return byType;
  const dot = fileName.lastIndexOf('.');
  const raw = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(raw) ? raw : 'audio';
}

/** Chiave S3 scelta dal server: prefisso consentito + slug del titolo + suffisso casuale + estensione. */
export function buildPublicUploadKey(title: string, fileName: string, contentType: string): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${PUBLIC_UPLOAD_PREFIX}${slugify(title || fileName)}-${suffix}.${extensionFor(contentType, fileName)}`;
}

const selectUpload = {
  id: true,
  uploaderUserId: true,
  title: true,
  artist: true,
  blobUrl: true,
  durationSeconds: true,
  published: true,
  playCount: true,
  createdAt: true,
} as const;

type UploadRow = {
  id: string;
  uploaderUserId: string;
  title: string;
  artist: string | null;
  blobUrl: string;
  durationSeconds: number;
  published: boolean;
  playCount: number;
  createdAt: Date;
};

/**
 * Riga DB → brano pubblico per il client. I brani pubblicati sono ascoltabili SOLO dagli utenti
 * Premium (o dal proprietario sui propri brani): a chi non può ascoltare NON si invia lo streamUrl
 * (null), così l'URL dell'oggetto non lascia mai il server verso un non abbonato. L'anteprima resta
 * visibile (titolo, artista, ascolti) ma bloccata.
 */
function toPublicUpload(
  row: UploadRow,
  viewerUserId: string | null,
  viewerPremium: boolean,
): PublicUpload {
  const mine = viewerUserId !== null && row.uploaderUserId === viewerUserId;
  const canPlay = mine || viewerPremium;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    streamUrl: canPlay ? row.blobUrl : null,
    durationSeconds: row.durationSeconds,
    playCount: row.playCount,
    createdAt: row.createdAt.toISOString(),
    mine,
    published: row.published,
    canPlay,
  };
}

/**
 * Registra un brano già caricato su S3. Si parte dalla CHIAVE (prefisso consentito) scelta dal
 * server al rilascio dell'URL firmato: l'URL pubblico è DERIVATO qui, così il client non può
 * registrare un URL arbitrario. HEAD dell'oggetto con timeout (fail-open): se S3 risponde si rifiuta
 * un oggetto chiaramente non audio; se va in timeout si procede (l'upload è passato dalla route
 * firmata — loggato, solo audio, max 40MB — e la chiave è nel prefisso consentito).
 *
 * HEAD serve anche da controllo di dimensione: l'URL PUT firmato NON vincola la dimensione del
 * corpo, quindi qui si rifiuta (e si rimuove) un oggetto oltre il tetto consentito, così non
 * finiscono su S3 file enormi serviti poi a tutti. Il tetto per utente è imposto in modo ATOMICO
 * (conteggio + create nella stessa transazione serializzabile), così richieste concorrenti non
 * possono superarlo.
 */
export async function registerPublicUpload(
  userId: string,
  input: PublicUploadCreateInput,
): Promise<PublicUpload> {
  if (!isS3Configured()) throw new StorageNotConfigured();
  if (!input.key.startsWith(PUBLIC_UPLOAD_PREFIX)) throw new InvalidPublicUploadSource();

  const head = await headObject(input.key);
  if (head?.contentType) {
    const contentType = head.contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (contentType && !contentType.startsWith('audio/')) {
      await deleteObject(input.key);
      throw new InvalidPublicUploadSource();
    }
  }
  // Dimensione reale dell'oggetto su S3: se supera il tetto, rimuovi e rifiuta (il PUT firmato non
  // la vincola). Fail-open resta solo quando HEAD va in timeout/errore (contentLength assente).
  if (head?.contentLength != null && head.contentLength > MAX_PUBLIC_UPLOAD_BYTES) {
    await deleteObject(input.key);
    throw new InvalidPublicUploadSource();
  }

  const objectUrl = s3ObjectUrl(input.key);
  const durationSeconds = Math.max(1, Math.min(86_400, Math.ceil(input.elapsedSeconds)));
  const data = {
    uploaderUserId: userId,
    title: input.title,
    artist: input.artist && input.artist.length > 0 ? input.artist : null,
    blobUrl: objectUrl,
    blobPathname: input.key,
    mimeType: input.mimeType,
    byteLength: input.byteLength,
    durationSeconds,
  };

  // Conteggio + create atomici: la transazione serializzabile impedisce a più richieste concorrenti
  // dello stesso utente di superare il tetto. Su conflitto di serializzazione si riprova una volta
  // (il nuovo conteggio vede la riga concorrente e fa scattare il tetto).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const row = await prisma.$transaction(
        async (tx) => {
          const existing = await tx.publicUpload.count({ where: { uploaderUserId: userId } });
          if (existing >= MAX_UPLOADS_PER_USER) throw new PublicUploadLimitReached();
          return tx.publicUpload.create({ data, select: selectUpload });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      // È un brano del proprietario stesso: può sempre ascoltarlo (canPlay).
      return toPublicUpload(row, userId, true);
    } catch (error) {
      if (error instanceof PublicUploadLimitReached) throw error;
      // Stesso oggetto già registrato (blobUrl/blobPathname unici): sorgente non valida.
      if (isUniqueViolation(error)) throw new InvalidPublicUploadSource();
      // Conflitto di serializzazione (P2034): riprova una sola volta.
      if (isSerializationFailure(error) && attempt === 0) continue;
      throw error;
    }
  }
  // Irraggiungibile: il ciclo ritorna o lancia sempre.
  throw new PublicUploadLimitReached();
}

/**
 * Classifica pubblica: brani pubblicati, i più ascoltati prima, poi i più recenti. `viewerPremium`
 * decide chi riceve lo streamUrl: solo gli utenti Premium (e il proprietario sui propri brani)
 * possono ascoltare; agli altri arriva l'anteprima bloccata (streamUrl null, canPlay false).
 */
export async function listPublicUploads(
  viewerUserId: string | null,
  viewerPremium: boolean,
): Promise<PublicUpload[]> {
  const rows = await prisma.publicUpload.findMany({
    where: { published: true },
    orderBy: [{ playCount: 'desc' }, { createdAt: 'desc' }],
    take: 100,
    select: selectUpload,
  });
  return rows.map((row) => toPublicUpload(row, viewerUserId, viewerPremium));
}

/** I brani caricati dall'utente (anche ritirati dalla moderazione), per gestirli. */
export async function listMyPublicUploads(userId: string): Promise<PublicUpload[]> {
  const rows = await prisma.publicUpload.findMany({
    where: { uploaderUserId: userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: selectUpload,
  });
  // Sono tutti brani del proprietario: li può sempre ascoltare (canPlay).
  return rows.map((row) => toPublicUpload(row, userId, true));
}

/**
 * Registra un ascolto (playCount) per la classifica. Non conta gli ascolti dell'autore stesso
 * (niente auto-gonfiaggio della propria posizione). Non fa mai throw bloccante per il player.
 */
export async function recordPublicUploadPlay(
  uploadId: string,
  viewerUserId: string | null,
): Promise<void> {
  try {
    const row = await prisma.publicUpload.findUnique({
      where: { id: uploadId },
      select: { uploaderUserId: true },
    });
    if (!row) return;
    // Il proprietario non fa punti sulla propria classifica.
    if (viewerUserId && row.uploaderUserId === viewerUserId) return;
    await prisma.publicUpload.update({
      where: { id: uploadId },
      data: { playCount: { increment: 1 } },
    });
  } catch {
    // Brano rimosso o non trovato: ignora.
  }
}

/**
 * Segnala un brano pubblicato. Una segnalazione per segnalatore (unique): oltre la soglia di
 * segnalatori distinti il brano si auto-ritira. Ritorna false se il brano pubblicato non esiste.
 */
export async function reportPublicUpload(
  uploadId: string,
  reporterUserId: string,
): Promise<boolean> {
  const upload = await prisma.publicUpload.findFirst({
    where: { id: uploadId, published: true },
    select: { id: true },
  });
  if (!upload) return false;

  try {
    await prisma.publicUploadReport.create({ data: { uploadId, reporterUserId } });
  } catch (error) {
    // Già segnalato da questo utente: non conta due volte, ma non è un errore.
    if (!isUniqueViolation(error)) throw error;
  }

  const reporters = await prisma.publicUploadReport.count({ where: { uploadId } });
  if (reporters >= AUTO_UNPUBLISH_REPORTS) {
    const row = await prisma.publicUpload.update({
      where: { id: uploadId },
      data: { published: false },
      select: { blobPathname: true },
    });
    // Takedown vero: rimuove l'oggetto da S3 (per chiave), così l'audio segnalato smette davvero
    // di essere servito.
    await deleteObject(row.blobPathname);
  }
  return true;
}

/** Rimuove un brano dell'utente: cancella l'oggetto su S3 e la riga. Ritorna false se non suo. */
export async function deletePublicUpload(userId: string, uploadId: string): Promise<boolean> {
  const row = await prisma.publicUpload.findFirst({
    where: { id: uploadId, uploaderUserId: userId },
    select: { id: true, blobPathname: true },
  });
  if (!row) return false;

  await deleteObject(row.blobPathname);
  await prisma.publicUpload.delete({ where: { id: row.id } });
  return true;
}

function isUniqueViolation(error: unknown): boolean {
  return hasPrismaCode(error, 'P2002');
}

/** P2034: transazione fallita per conflitto di scrittura/serializzazione (va ritentata). */
function isSerializationFailure(error: unknown): boolean {
  return hasPrismaCode(error, 'P2034');
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
