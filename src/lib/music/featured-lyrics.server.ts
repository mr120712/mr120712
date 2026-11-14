// @polsia:user-owned — TESTO dei "brani in evidenza" (file audio dell'amministratore nello store
// Vercel Blob) per il player. Il testo è un'opera letteraria con diritti PROPRI (autori ed editori),
// separati da quelli della registrazione: si mostra SOLO per i brani dichiarati in diritti.json con
// "testo": true (voce valida, file esistente; vedi featured-rights.server.ts). Mai testi presi da
// siti o servizi di terzi.
//
// Da dove si legge, in quest'ordine:
// 1. un file accanto al brano con lo stesso nome ed estensione .lrc (sincronizzato) o .txt
//    (semplice), maiuscole dell'estensione indifferenti, UTF-8 (BOM ammesso), al massimo 64 KB;
// 2. il testo incorporato nel file audio (USLT/SYLT, LYRICS/UNSYNCEDLYRICS, ©lyr), letto con
//    music-metadata dai PRIMI 4 MB al massimo (richiesta Range, mai il brano intero).
// Cache in memoria: ~10 minuti se il testo c'è, ~2 minuti se manca o la lettura fallisce. Il
// permesso ("testo": true) si ricontrolla a ogni richiesta sull'indice della ricerca (al massimo ~5
// minuti di ritardo per una revoca). Scadenza complessiva breve. Non fa mai throw.
import 'server-only';
import { get } from '@vercel/blob';
import { parseBuffer } from 'music-metadata';
import { featuredLyricsCredit, type Lyrics } from '@/lib/contracts/lyrics';
import { env } from '@/lib/env';
import { audioMimeForPathname, lyricsFromMetadata } from '@/lib/music/embedded-lyrics';
import { readUpTo } from '@/lib/music/featured-rights.server';
import {
  type FeaturedLyricsSource,
  getFeaturedLyricsSource,
} from '@/lib/music/featured-search.server';
import {
  encodeBlobPathname,
  type HomeStoreFile,
  isPublicBlobUrl,
} from '@/lib/music/home-tracks.server';
import { type ParsedLyrics, parseLyrics } from '@/lib/music/lyrics';

/** Dimensione massima di un file .lrc/.txt: oltre si ignora. */
export const LYRICS_SIDECAR_MAX_BYTES = 64 * 1024;
/** Byte letti al massimo dall'inizio del file audio per il testo incorporato. */
export const EMBEDDED_LYRICS_MAX_BYTES = 4 * 1024 * 1024;
const HIT_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 2 * 60_000;
/** Tempo massimo per trovare il testo di un brano (file accanto + testo incorporato). */
const DEADLINE_MS = 8000;
/** Testi tenuti in memoria al massimo (i più vecchi escono per primi). */
const MAX_CACHE_ENTRIES = 200;

type CacheEntry = { value: ParsedLyrics | null; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<ParsedLyrics | null>>();
let generation = 0;

/** Svuota la cache dei testi (solo per i test). */
export function clearFeaturedLyricsCacheForTests() {
  cache.clear();
  pending.clear();
  generation += 1;
}

function abortAfter(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** Chiave della cache: il brano più i file di testo (nome, data, dimensione) che lo accompagnano. */
function cacheKey(source: FeaturedLyricsSource): string {
  return [
    source.pathname,
    ...source.sidecars.map((file) => `${file.pathname}@${file.uploadedAt.getTime()}:${file.size}`),
  ].join('|');
}

/** Testo di un file .lrc/.txt, o null (troppo grande, non UTF-8, vuoto, illeggibile). */
async function readSidecar(token: string, file: HomeStoreFile): Promise<ParsedLyrics | null> {
  if (file.size > LYRICS_SIDECAR_MAX_BYTES) return null;
  const result = await get(encodeBlobPathname(file.pathname), {
    access: isPublicBlobUrl(file.url) ? 'public' : 'private',
    token,
    abortSignal: abortAfter(DEADLINE_MS),
  });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const declared = Number(result.headers.get('content-length') ?? '0');
  if (declared > LYRICS_SIDECAR_MAX_BYTES) {
    await result.stream.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await readUpTo(result.stream, LYRICS_SIDECAR_MAX_BYTES + 1);
  if (bytes.length === 0 || bytes.length > LYRICS_SIDECAR_MAX_BYTES) return null;
  let text: string;
  try {
    // UTF-8 rigoroso; il BOM iniziale lo toglie il decoder stesso.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return parseLyrics(text);
}

/** Testo incorporato nel file audio, dai primi EMBEDDED_LYRICS_MAX_BYTES byte al massimo. */
async function readEmbedded(
  token: string,
  source: FeaturedLyricsSource,
): Promise<ParsedLyrics | null> {
  const result = await get(encodeBlobPathname(source.pathname), {
    access: source.audioPublic ? 'public' : 'private',
    token,
    abortSignal: abortAfter(DEADLINE_MS),
    headers: { range: `bytes=0-${EMBEDDED_LYRICS_MAX_BYTES - 1}` },
  });
  // Risposta parziale (206) o intera (200): conta solo che ci siano byte da leggere.
  if (!result?.stream) return null;
  // Anche senza supporto Range (file intero), si legge al massimo il tetto e si chiude lo stream.
  const bytes = await readUpTo(result.stream, EMBEDDED_LYRICS_MAX_BYTES);
  if (bytes.length === 0) return null;
  const mimeType = audioMimeForPathname(source.pathname) ?? undefined;
  const metadata = await parseBuffer(
    bytes,
    { mimeType, path: source.pathname, size: bytes.length },
    { skipCovers: true, duration: false, skipPostHeaders: true },
  );
  return lyricsFromMetadata(metadata);
}

/** Primo testo trovato: i file accanto (.lrc poi .txt), poi quello incorporato. Mai throw. */
async function findLyrics(
  token: string,
  source: FeaturedLyricsSource,
): Promise<ParsedLyrics | null> {
  for (const file of source.sidecars) {
    const parsed = await readSidecar(token, file).catch(() => null);
    if (parsed) return parsed;
  }
  return readEmbedded(token, source).catch(() => null);
}

function remember(key: string, value: ParsedLyrics | null) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS) });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Il testo di un brano autorizzato, dalla cache o letto una sola volta (richieste concorrenti). */
async function cachedLyrics(
  token: string,
  source: FeaturedLyricsSource,
): Promise<ParsedLyrics | null> {
  const key = cacheKey(source);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const running = pending.get(key);
  if (running) return running;

  const started = generation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), DEADLINE_MS);
  });
  const work = Promise.race([findLyrics(token, source), deadline])
    .then((value) => {
      const parsed = value === 'timeout' ? null : value;
      if (started === generation) remember(key, parsed);
      return parsed;
    })
    .catch(() => null)
    .finally(() => {
      clearTimeout(timer);
      if (pending.get(key) === work) pending.delete(key);
    });
  pending.set(key, work);
  return work;
}

/**
 * Il testo di un brano in evidenza per il player, o null quando non c'è O non è autorizzato (le
 * due risposte sono identiche: nessun indizio su cosa esiste nello store). `pathname` deve già
 * essere un brano in evidenza valido (isHomeAudioBlob). Non fa mai throw.
 */
export async function readFeaturedLyrics(pathname: string): Promise<Lyrics | null> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const source = await getFeaturedLyricsSource(pathname);
    if (!source) return null;
    const parsed = await cachedLyrics(token, source);
    if (!parsed) return null;
    return {
      kind: parsed.kind,
      lines: parsed.lines,
      source: 'featured',
      credit: featuredLyricsCredit(source.holder),
    };
  } catch {
    return null;
  }
}
