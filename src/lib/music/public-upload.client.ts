// @polsia:user-owned — lato browser del caricamento nella libreria pubblica: il file va DIRETTO su
// AWS S3 (PUT firmato dal server), poi si registrano i metadati via API (si manda la CHIAVE).
'use client';

import { apiFetch } from '@/lib/api-client';
import {
  type PublicUpload,
  PublicUploadCreateResponseSchema,
  PublicUploadPresignResponseSchema,
} from '@/lib/contracts/public-uploads';

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

// MIME audio canonico per estensione: serve quando il browser non dichiara il tipo (molti MP3
// arrivano con file.type vuoto o application/octet-stream). .mp4/.webm esclusi (anche video).
const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  weba: 'audio/webm',
};

export const AUDIO_UPLOAD_EXTENSIONS = Object.keys(MIME_BY_EXTENSION);

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** MIME audio da usare per un file scelto, o null se non è riconoscibile come audio. */
export function audioUploadMimeType(declaredType: string, fileName: string): string | null {
  const declared = declaredType.trim().toLowerCase();
  if (declared.startsWith('audio/')) return declared;
  return MIME_BY_EXTENSION[fileExtension(fileName)] ?? null;
}

/** True se il File va ricostruito con un MIME sintetico (il browser non ha dichiarato audio). */
export function shouldReassignMime(declaredType: string): boolean {
  return !declaredType.trim().toLowerCase().startsWith('audio/');
}

/** Alias di tipi audio che i browser dichiarano, mappati sul sottotipo canonico accettato. */
const MIME_ALIASES: Record<string, string> = {
  'audio/mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-flac': 'audio/flac',
  'audio/x-aac': 'audio/aac',
  'audio/opus': 'audio/ogg',
};

/**
 * MIME canonico (uno degli accettati) per un file: prima l'estensione nota, poi l'alias del tipo
 * dichiarato, infine il tipo base dichiarato. Serve perché il browser a volte dichiara alias
 * (audio/x-m4a, audio/mp3) che il server rifiuterebbe, e DEVE combaciare col Content-Type firmato.
 */
function canonicalAudioMime(file: File): string {
  const byExt = MIME_BY_EXTENSION[fileExtension(file.name)];
  if (byExt) return byExt;
  const declared = (file.type || '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return MIME_ALIASES[declared] ?? (declared.startsWith('audio/') ? declared : 'audio/mpeg');
}

/**
 * Durata del file lato client (fallback se il contenitore non la riporta). Si risolve SEMPRE entro
 * un timeout: con certi file né `onloadedmetadata` né `onerror` scattano, e senza timeout la promise
 * resterebbe appesa per sempre bloccando il caricamento.
 */
export function readDurationSeconds(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(value);
    };
    timer = setTimeout(() => finish(0), 8000);
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => finish(0);
    audio.src = url;
  });
}

export class PublicUploadError extends Error {}

/**
 * PUT del file all'URL firmato di S3 via XMLHttpRequest: così si ha la barra di avanzamento (fetch
 * non espone il progresso di upload) e un timeout (180s) che evita il "caricamento infinito".
 * Il Content-Type DEVE combaciare con quello firmato dal server, altrimenti S3 rifiuta la firma.
 */
function putToS3(
  url: string,
  file: File,
  contentType: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.timeout = 180_000;
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new PublicUploadError('Caricamento del file non riuscito.'));
    };
    xhr.onerror = () =>
      reject(new PublicUploadError('Caricamento del file non riuscito: controlla la rete.'));
    xhr.ontimeout = () =>
      reject(new PublicUploadError('Caricamento del file troppo lento: riprova.'));
    xhr.send(file);
  });
}

function presignError(error: unknown): PublicUploadError {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; message?: unknown })
      : null;
  if (cause?.error === 'not_configured') {
    return new PublicUploadError(
      'Il caricamento non è disponibile in questo momento: lo storage (AWS S3) non è configurato sul server.',
    );
  }
  if (typeof cause?.message === 'string' && cause.message.trim()) {
    return new PublicUploadError(cause.message.trim());
  }
  return new PublicUploadError('Caricamento non riuscito. Riprova.');
}

/**
 * Carica un file audio nella libreria pubblica: (1) chiede un URL PUT firmato, (2) carica i byte
 * DIRETTO su S3, (3) registra i metadati con la chiave. `file` deve avere un MIME audio riconosciuto.
 */
export async function uploadPublicSong(
  file: File,
  options: { title: string; artist?: string; onProgress?: (percent: number) => void },
): Promise<PublicUpload> {
  const mime = canonicalAudioMime(file);

  // Durata PRIMA del caricamento (con timeout interno): così dopo il 100% resta solo la
  // registrazione e non c'è nessun passo che possa "piantarsi" dopo la barra piena.
  const seconds = Math.max(1, Math.ceil(await readDurationSeconds(file)));

  let presigned: { uploadUrl: string; key: string; contentType: string };
  try {
    presigned = await apiFetch('/api/music/public-uploads/blob', {
      method: 'POST',
      body: JSON.stringify({
        title: options.title,
        fileName: file.name,
        contentType: mime,
        byteLength: file.size,
      }),
      schema: PublicUploadPresignResponseSchema,
    });
  } catch (error) {
    throw presignError(error);
  }

  await putToS3(presigned.uploadUrl, file, presigned.contentType, options.onProgress);

  // Timeout sulla registrazione: se il server non risponde, l'interfaccia non resta appesa in
  // eterno — fallisce con un errore invece di "piantarsi".
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(45_000)
      : undefined;
  const { upload: created } = await apiFetch('/api/music/public-uploads', {
    method: 'POST',
    body: JSON.stringify({
      title: options.title,
      artist: options.artist,
      key: presigned.key,
      mimeType: mime,
      byteLength: file.size,
      elapsedSeconds: seconds,
    }),
    schema: PublicUploadCreateResponseSchema,
    signal,
  });
  return created;
}
