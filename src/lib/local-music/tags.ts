// @polsia:user-owned — titolo, artista, album e copertina di un file audio del dispositivo.
//
// readAudioTags legge solo a pezzi con Blob.slice, mai l'intero file in memoria: l'header ID3v2
// (10 byte) e poi il tag fino a 2 MiB; per gli MP4/M4A gli header dei box e il box dei tag (vedi
// mp4.ts); in mancanza d'altro gli ultimi 128 byte (ID3v1). Nessuna eccezione esce da qui: senza
// tag leggibili restano i campi vuoti e tagsFromFileName ricava titolo e artista dal nome del file
// ("Artista - Titolo.mp3").

import { ID3V1_BYTES, parseId3v1, parseId3v2, readId3v2Header } from '@/lib/local-music/id3';
import { looksLikeMp4, readMp4Tags } from '@/lib/local-music/mp4';
import {
  type ByteReader,
  fillMissingTags,
  MAX_TAG_BYTES,
  sanitizeTagText,
} from '@/lib/local-music/tag-utils';
import { type AudioTags, emptyTags } from '@/lib/local-music/types';

async function blobBytes(part: Blob): Promise<Uint8Array> {
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        resolve(result instanceof ArrayBuffer ? new Uint8Array(result) : new Uint8Array(0));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(part);
    });
  }
  return new Uint8Array(await new Response(part).arrayBuffer());
}

/** Lettore a pezzi di un Blob: ogni lettura è limitata a MAX_TAG_BYTES e ai byte del file. */
export function blobByteReader(blob: Blob): ByteReader {
  return async (start, end) => {
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(Math.floor(end), from + MAX_TAG_BYTES, blob.size);
    if (!(to > from)) return new Uint8Array(0);
    return blobBytes(blob.slice(from, to));
  };
}

async function readId3v1At(read: ByteReader, size: number): Promise<AudioTags> {
  if (size < ID3V1_BYTES) return emptyTags();
  return parseId3v1(await read(size - ID3V1_BYTES, size));
}

function complete(tags: AudioTags): boolean {
  return tags.title !== null && tags.artist !== null && tags.album !== null;
}

async function readTagsUnchecked(blob: Blob): Promise<AudioTags> {
  const size = blob.size;
  if (!Number.isFinite(size) || size <= 0) return emptyTags();
  const read = blobByteReader(blob);
  const head = await read(0, 16);

  const id3 = readId3v2Header(head);
  if (id3) {
    const tags = parseId3v2(await read(0, Math.min(id3.totalSize, MAX_TAG_BYTES)));
    return complete(tags) ? tags : fillMissingTags(tags, await readId3v1At(read, size));
  }
  if (looksLikeMp4(head)) return readMp4Tags(read, size);
  return readId3v1At(read, size);
}

/** Tag del file (ID3v2, MP4 'ilst' o ID3v1). Mai un'eccezione: al peggio campi vuoti. */
export async function readAudioTags(blob: Blob): Promise<AudioTags> {
  try {
    return await readTagsUnchecked(blob);
  } catch {
    return emptyTags();
  }
}

const UNTITLED = 'Brano senza titolo';

/**
 * Titolo e artista dal nome del file: "Artista - Titolo.mp3" → artista e titolo; un numero di
 * traccia iniziale ("01 - Titolo", "01. Titolo") è ignorato; altrimenti il nome senza estensione.
 */
export function tagsFromFileName(name: string): { title: string; artist: string | null } {
  const raw = typeof name === 'string' ? name : '';
  const base = raw.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const stem =
    dot > 0 && /^[A-Za-z0-9]{1,5}$/.test(base.slice(dot + 1)) ? base.slice(0, dot) : base;
  const clean = sanitizeTagText(stem.replace(/_/g, ' '), 400) ?? '';

  const parts = clean
    .split(/\s+[-–—]\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length >= 2 && /^\d{1,3}\.?$/.test(parts[0] ?? '')) parts.shift();

  if (parts.length >= 2) {
    const artist = sanitizeTagText(parts[0]);
    const title = sanitizeTagText(parts.slice(1).join(' - '));
    if (artist && title) return { title, artist };
  }
  const single = (parts[0] ?? clean).replace(/^\d{1,3}\s*[.)]\s+(?=\S)/, '');
  return { title: sanitizeTagText(single) ?? sanitizeTagText(clean) ?? UNTITLED, artist: null };
}
