// @polsia:user-owned — lato browser del caricamento nella libreria pubblica: il file va DIRETTO su
// Vercel Blob (client upload, niente passaggio dal server), poi si registrano i metadati via API.
'use client';

import { upload } from '@vercel/blob/client';
import { apiFetch } from '@/lib/api-client';
import {
  type PublicUpload,
  PublicUploadCreateResponseSchema,
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

function extensionForMime(mime: string): string {
  for (const [ext, value] of Object.entries(MIME_BY_EXTENSION)) if (value === mime) return ext;
  return 'audio';
}

/** Alias di tipi audio che i browser dichiarano, mappati sul sottotipo canonico accettato dal token. */
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
 * MIME canonico (uno degli accettati dal token Blob) per un file: prima l'estensione nota, poi
 * l'alias del tipo dichiarato, infine il tipo base dichiarato. Serve perché il browser a volte
 * dichiara alias (audio/x-m4a, audio/mp3) che il token rifiuterebbe.
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

export class PublicUploadError extends Error {}

/**
 * Carica un file audio nella libreria pubblica: prima su Vercel Blob (oggetto pubblico), poi
 * registra i metadati. `file` deve avere un MIME audio non vuoto (usa audioUploadMimeType prima).
 */
export async function uploadPublicSong(
  file: File,
  options: { title: string; artist?: string; onProgress?: (percent: number) => void },
): Promise<PublicUpload> {
  const mime = canonicalAudioMime(file);
  const pathname = `public-uploads/${slugify(options.title || file.name)}.${extensionForMime(mime)}`;

  let result: Awaited<ReturnType<typeof upload>>;
  try {
    result = await upload(pathname, file, {
      access: 'public',
      handleUploadUrl: '/api/music/public-uploads/blob',
      contentType: mime,
      onUploadProgress: options.onProgress
        ? ({ percentage }) => options.onProgress?.(Math.round(percentage))
        : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Il client Blob dà "Failed to retrieve the client token" quando il nostro endpoint del token
    // risponde non-2xx: la causa tipica è lo storage non configurato sul server.
    if (/client token/i.test(message) || /not.?configured/i.test(message)) {
      throw new PublicUploadError(
        'Il caricamento non è disponibile in questo momento: lo storage (Vercel Blob) non è configurato sul server.',
      );
    }
    throw new PublicUploadError(message || 'Caricamento del file non riuscito.');
  }

  const seconds = Math.max(1, Math.ceil(await readDurationSeconds(file)));
  const { upload: created } = await apiFetch('/api/music/public-uploads', {
    method: 'POST',
    body: JSON.stringify({
      title: options.title,
      artist: options.artist,
      blobUrl: result.url,
      blobPathname: result.pathname,
      mimeType: mime.split(';', 1)[0]?.trim().toLowerCase() ?? mime,
      byteLength: file.size,
      elapsedSeconds: seconds,
    }),
    schema: PublicUploadCreateResponseSchema,
  });
  return created;
}
