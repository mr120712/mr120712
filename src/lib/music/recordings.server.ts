// @polsia:user-owned — brani registrati dall'utente, ospitati interamente su Solco.
// Il file è privato (uploadPrivateFile → R2 Polsia) e qui viene solo ispezionato e
// registrato: la durata è ricavata dal server, mai dal client.
import 'server-only';
import type { Recording } from '@/lib/contracts/recordings';
import { prisma } from '@/lib/db';
import {
  InvalidPrivateAudioSource,
  inspectPrivateAudioSource,
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

type RecordingRow = {
  id: string;
  title: string;
  durationSeconds: number;
  createdAt: Date;
};

function toRecording(row: RecordingRow): Recording {
  return {
    id: row.id,
    title: row.title,
    durationSeconds: row.durationSeconds,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRecordings(userId: string): Promise<Recording[]> {
  const rows = await prisma.userRecording.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, durationSeconds: true, createdAt: true },
    take: MAX_RECORDINGS_PER_USER,
  });
  return rows.map(toRecording);
}

/**
 * Registra una registrazione già caricata in archivio privato. Ispeziona il file
 * (conferma che è davvero audio e ne ricava la durata) prima di salvarlo.
 */
export async function registerRecording(
  userId: string,
  input: { title: string; fileKey: string; mimeType: string; byteLength: number },
): Promise<Recording> {
  const existing = await prisma.userRecording.count({ where: { userId } });
  if (existing >= MAX_RECORDINGS_PER_USER) throw new RecordingLimitReached();

  let durationSeconds: number;
  try {
    const inspected = await inspectPrivateAudioSource(
      input.fileKey,
      input.mimeType,
      input.byteLength,
    );
    durationSeconds = Math.min(
      MAX_DURATION_SECONDS,
      Math.max(1, Math.ceil(inspected.durationSeconds)),
    );
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
      select: { id: true, title: true, durationSeconds: true, createdAt: true },
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
  const result = await prisma.userRecording.deleteMany({ where: { id: recordingId, userId } });
  return result.count > 0;
}

/** Apre lo stream del file privato (con eventuale Range). */
export function openRecordingStream(fileKey: string, range: string | null) {
  return openPrivateAudioSource(fileKey, range);
}
