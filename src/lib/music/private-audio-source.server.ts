// @polsia:user-owned
import 'server-only';
import { parseWebStream } from 'music-metadata';
import { signFileUrls } from '@/modules/file-upload/server';

export type InspectedAudioSource = {
  mimeType: string;
  byteLength: number;
  durationSeconds: number;
};

const audioMimePattern = /^audio\/[a-z0-9][a-z0-9.+-]*$/;
const evidenceMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function hasEvidenceSignature(mimeType: string, bytes: Uint8Array) {
  const startsWith = (...expected: number[]) =>
    expected.every((byte, index) => bytes[index] === byte);
  return (
    (mimeType === 'application/pdf' && startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) ||
    (mimeType === 'image/jpeg' && startsWith(0xff, 0xd8, 0xff)) ||
    (mimeType === 'image/png' && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
  );
}

export class PrivateAudioStorageUnavailable extends Error {
  constructor() {
    super('private_audio_source_unavailable');
  }
}

export class InvalidPrivateAudioSource extends Error {
  constructor() {
    super('invalid_audio_source');
  }
}

export class InvalidPrivateEvidenceFile extends Error {
  constructor() {
    super('invalid_private_evidence_file');
  }
}

export async function signedPrivateAudioUrl(fileKey: string) {
  const signedFiles = await signFileUrls([fileKey]);
  const url = signedFiles.get(fileKey);
  if (!url) throw new PrivateAudioStorageUnavailable();
  return url;
}

export async function openPrivateAudioSource(fileKey: string, range: string | null) {
  const url = await signedPrivateAudioUrl(fileKey);
  return fetch(url, {
    ...(range ? { headers: { Range: range } } : {}),
    cache: 'no-store',
    redirect: 'error',
  });
}

/** Checks private storage without exposing the object or reading the whole song. */
export async function isPrivateAudioSourceAvailable(
  fileKey: string,
  expectedMimeType: string,
  expectedByteLength: number,
) {
  let response: Response | null = null;
  try {
    const url = await signedPrivateAudioUrl(fileKey);
    response = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      redirect: 'error',
    });
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    const range = response.headers.get('content-range');
    const contentLength = response.headers.get('content-length');
    const validHeaders =
      response.status === 206 &&
      Boolean(response.body) &&
      mimeType === expectedMimeType.toLowerCase() &&
      contentLength === '1' &&
      range === `bytes 0-0/${expectedByteLength}`;
    if (!validHeaders || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      return false;
    }

    const reader = response.body.getReader();
    try {
      const chunk = await reader.read();
      return !chunk.done && chunk.value.byteLength === 1;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    void response?.body?.cancel().catch(() => undefined);
    return false;
  }
}

/** Rechecks that the private proof document is still available and matches its registered file. */
export async function isPrivateEvidenceFileAvailable(
  fileKey: string,
  expectedMimeType: string,
  expectedByteLength: number,
) {
  if (!evidenceMimeTypes.has(expectedMimeType.toLowerCase()) || expectedByteLength < 8)
    return false;
  let response: Response | null = null;
  try {
    const url = await signedPrivateAudioUrl(fileKey);
    response = await fetch(url, {
      headers: { Range: 'bytes=0-7' },
      cache: 'no-store',
      redirect: 'error',
    });
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    const validHeaders =
      response.status === 206 &&
      Boolean(response.body) &&
      mimeType === expectedMimeType.toLowerCase() &&
      response.headers.get('content-length') === '8' &&
      response.headers.get('content-range') === `bytes 0-7/${expectedByteLength}`;
    if (!validHeaders || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      return false;
    }

    const reader = response.body.getReader();
    const prefix: number[] = [];
    try {
      while (prefix.length < 8) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const byte of chunk.value) {
          prefix.push(byte);
          if (prefix.length === 8) break;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return prefix.length === 8 && hasEvidenceSignature(mimeType, Uint8Array.from(prefix));
  } catch {
    void response?.body?.cancel().catch(() => undefined);
    return false;
  }
}

export async function inspectPrivateAudioSource(
  fileKey: string,
  expectedMimeType: string,
  expectedByteLength: number,
): Promise<InspectedAudioSource> {
  const url = await signedPrivateAudioUrl(fileKey);
  const response = await fetch(url, { cache: 'no-store', redirect: 'error' });
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const contentLength = response.headers.get('content-length');

  if (
    !response.ok ||
    !response.body ||
    !mimeType ||
    !audioMimePattern.test(mimeType) ||
    mimeType !== expectedMimeType.toLowerCase() ||
    contentLength !== String(expectedByteLength)
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new PrivateAudioStorageUnavailable();
  }

  let metadata: Awaited<ReturnType<typeof parseWebStream>>;
  try {
    metadata = await parseWebStream(
      response.body,
      { mimeType, size: expectedByteLength },
      { skipCovers: true },
    );
  } catch {
    throw new InvalidPrivateAudioSource();
  }
  const durationSeconds = metadata.format.duration;
  if (!Number.isFinite(durationSeconds) || !durationSeconds || durationSeconds <= 0) {
    throw new InvalidPrivateAudioSource();
  }

  return { mimeType, byteLength: expectedByteLength, durationSeconds };
}

/**
 * Come inspectPrivateAudioSource, ma per le registrazioni dell'utente: valida che il file sia
 * davvero audio (MIME + dimensione + parsing), però NON rifiuta se manca la durata nel contenitore.
 * I blob WebM/Opus di MediaRecorder (Chrome/Firefox) spesso non scrivono l'elemento Duration, quindi
 * `format.duration` è assente: in quel caso ritorna durationSeconds null e chi chiama usa la durata
 * misurata dal client. Un file che non è audio fa comunque throw (InvalidPrivateAudioSource).
 */
export async function inspectRecordingSource(
  fileKey: string,
  expectedMimeType: string,
  expectedByteLength: number,
): Promise<{ mimeType: string; byteLength: number; durationSeconds: number | null }> {
  const url = await signedPrivateAudioUrl(fileKey);
  const response = await fetch(url, { cache: 'no-store', redirect: 'error' });
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const contentLength = response.headers.get('content-length');

  if (
    !response.ok ||
    !response.body ||
    !mimeType ||
    !audioMimePattern.test(mimeType) ||
    mimeType !== expectedMimeType.toLowerCase() ||
    contentLength !== String(expectedByteLength)
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new PrivateAudioStorageUnavailable();
  }

  let metadata: Awaited<ReturnType<typeof parseWebStream>>;
  try {
    metadata = await parseWebStream(
      response.body,
      { mimeType, size: expectedByteLength },
      { skipCovers: true },
    );
  } catch {
    throw new InvalidPrivateAudioSource();
  }
  const duration = metadata.format.duration;
  const durationSeconds =
    Number.isFinite(duration) && typeof duration === 'number' && duration > 0 ? duration : null;

  return { mimeType, byteLength: expectedByteLength, durationSeconds };
}

export async function inspectPrivateEvidenceFile(
  fileKey: string,
  expectedMimeType: string,
  expectedByteLength: number,
) {
  const url = await signedPrivateAudioUrl(fileKey);
  const response = await fetch(url, { cache: 'no-store', redirect: 'error' });
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();

  if (
    !response.ok ||
    !response.body ||
    mimeType !== expectedMimeType.toLowerCase() ||
    response.headers.get('content-length') !== String(expectedByteLength)
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new PrivateAudioStorageUnavailable();
  }

  const reader = response.body.getReader();
  const prefix: number[] = [];
  try {
    while (prefix.length < 8) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const byte of chunk.value) {
        prefix.push(byte);
        if (prefix.length === 8) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (!hasEvidenceSignature(mimeType, Uint8Array.from(prefix))) {
    throw new InvalidPrivateEvidenceFile();
  }
  return { mimeType, byteLength: expectedByteLength };
}
