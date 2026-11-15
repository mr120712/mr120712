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
// permesso ("testo": true) si ricontrolla a ogni richiesta sull'indice della ricerca (che segue la
// versione del catalogo: di solito ~30-90 secondi per una revoca, al più ~5 minuti). Scadenza
// complessiva breve. Non fa mai throw.
//
// La pagina admin «Diritti e testi» usa getFeaturedLyricsAvailability: STESSA ricerca e STESSA
// cache, ma esce solo se il testo c'è, da dove viene (.lrc, .txt, incorporato), il tipo e quante
// righe ha. Mai il testo, nemmeno una riga. Ogni esito finisce anche in una seconda cache SENZA
// testo (solo fonte, tipo e righe), grande quanto i brani della pagina admin: così la diagnosi
// non dipende dai 200 testi del player e i suoi controlli non si ripetono a ogni «Aggiorna».
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
import { type LyricsKind, type ParsedLyrics, parseLyrics } from '@/lib/music/lyrics';

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
/**
 * Esiti SENZA testo tenuti in memoria al massimo per la pagina admin (quanti i brani che mostra,
 * FEATURED_RIGHTS_MAX_TRACKS): pochi byte l'uno.
 */
const MAX_AVAILABILITY_ENTRIES = 5000;

/** Da dove viene il testo trovato. */
export type FeaturedLyricsOrigin = 'lrc' | 'txt' | 'embedded';
type FoundLyrics = { lyrics: ParsedLyrics; origin: FeaturedLyricsOrigin };
/** Esito di una ricerca del testo: `failed` = una lettura è andata in errore o oltre la scadenza. */
type LyricsLookup = { found: FoundLyrics | null; failed: boolean };
type CacheEntry = { value: LyricsLookup; expiresAt: number };

const cache = new Map<string, CacheEntry>();
/** Stessa chiave e stessa scadenza di `cache`, ma solo la disponibilità: MAI il testo. */
const availabilityCache = new Map<
  string,
  { value: FeaturedLyricsAvailability; expiresAt: number }
>();
const pending = new Map<string, Promise<LyricsLookup>>();
let generation = 0;

/** Svuota la cache dei testi (solo per i test). */
export function clearFeaturedLyricsCacheForTests() {
  cache.clear();
  availabilityCache.clear();
  pending.clear();
  generation += 1;
}

/**
 * Dimentica il testo in cache di UN brano (dopo il salvataggio di un .lrc dalla pagina admin):
 * player e diagnosi lo rileggono alla richiesta successiva. Le letture già in corso non scrivono
 * più in cache. Le chiavi sono "pathname|file accanto…": si tolgono tutte quelle del brano.
 */
export function invalidateFeaturedLyricsCache(pathname: string) {
  const ofTrack = (key: string) => key === pathname || key.startsWith(`${pathname}|`);
  for (const key of [...cache.keys()]) if (ofTrack(key)) cache.delete(key);
  for (const key of [...availabilityCache.keys()]) if (ofTrack(key)) availabilityCache.delete(key);
  for (const key of [...pending.keys()]) if (ofTrack(key)) pending.delete(key);
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

/** .lrc o .txt, dall'estensione del file accanto al brano (maiuscole indifferenti). */
function sidecarOrigin(pathname: string): FeaturedLyricsOrigin {
  return pathname.toLowerCase().endsWith('.lrc') ? 'lrc' : 'txt';
}

/**
 * Primo testo trovato: i file accanto (.lrc poi .txt), poi quello incorporato. Mai throw: una
 * lettura in errore passa alla fonte successiva e, se nessuna dà un testo, l'esito è `failed`.
 */
async function findLyrics(token: string, source: FeaturedLyricsSource): Promise<LyricsLookup> {
  let failed = false;
  const onError = () => {
    failed = true;
    return null;
  };
  for (const file of source.sidecars) {
    const parsed = await readSidecar(token, file).catch(onError);
    if (parsed) return { found: { lyrics: parsed, origin: sidecarOrigin(file.pathname) }, failed };
  }
  const embedded = await readEmbedded(token, source).catch(onError);
  return { found: embedded ? { lyrics: embedded, origin: 'embedded' } : null, failed };
}

/** Inserisce in una cache a capienza fissa: i più vecchi escono per primi. */
function putCapped<V>(map: Map<string, V>, key: string, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function remember(key: string, value: LyricsLookup) {
  const expiresAt = Date.now() + (value.found ? HIT_TTL_MS : MISS_TTL_MS);
  putCapped(cache, key, { value, expiresAt }, MAX_CACHE_ENTRIES);
  putCapped(
    availabilityCache,
    key,
    { value: availabilityOf(value), expiresAt },
    MAX_AVAILABILITY_ENTRIES,
  );
}

const LOOKUP_FAILED: LyricsLookup = { found: null, failed: true };

/**
 * Il testo di un brano autorizzato, dalla cache o letto una sola volta (richieste concorrenti).
 * `retryFailed` (solo la diagnosi admin): un esito "lettura fallita" in cache non vale, si rilegge.
 */
async function cachedLyrics(
  token: string,
  source: FeaturedLyricsSource,
  retryFailed = false,
): Promise<LyricsLookup> {
  const key = cacheKey(source);
  const hit = cache.get(key);
  const stale = retryFailed && hit !== undefined && hit.value.failed && !hit.value.found;
  if (hit && hit.expiresAt > Date.now() && !stale) return hit.value;
  const running = pending.get(key);
  if (running) return running;

  const started = generation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), DEADLINE_MS);
  });
  const work = Promise.race([findLyrics(token, source), deadline])
    .then((value) => {
      const lookup = value === 'timeout' ? LOOKUP_FAILED : value;
      if (started === generation) remember(key, lookup);
      return lookup;
    })
    .catch(() => LOOKUP_FAILED)
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
    const parsed = (await cachedLyrics(token, source)).found?.lyrics;
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

/**
 * Disponibilità del testo per la diagnosi dell'amministratore: da dove viene, tipo e numero di
 * righe. NESSUN campo con il testo: il tipo stesso non lo prevede. 'none' = nessuna fonte ha un
 * testo; 'error' = nessun testo e almeno una lettura è fallita o è scaduta. `sidecarError` = il
 * testo viene da una fonte successiva perché la LETTURA di un file accanto è fallita (errore di
 * rete o tempo scaduto, non un file inutilizzabile).
 */
export type FeaturedLyricsAvailability =
  | { status: FeaturedLyricsOrigin; kind: LyricsKind; lineCount: number; sidecarError?: true }
  | { status: 'none' | 'error' };

function availabilityOf(lookup: LyricsLookup): FeaturedLyricsAvailability {
  if (lookup.found) {
    return {
      status: lookup.found.origin,
      kind: lookup.found.lyrics.kind,
      lineCount: lookup.found.lyrics.lines.length,
      // Con un testo trovato, `failed` può venire solo da un file accanto letto prima (findLyrics).
      ...(lookup.failed ? { sidecarError: true as const } : {}),
    };
  }
  return { status: lookup.failed ? 'error' : 'none' };
}

function cachedAvailability(key: string): FeaturedLyricsAvailability | undefined {
  const hit = availabilityCache.get(key);
  return hit && hit.expiresAt > Date.now() ? hit.value : undefined;
}

/**
 * Solo dalla cache, senza leggere nulla: la disponibilità se il brano è già stato controllato
 * (dal player o dalla pagina admin) e non è scaduta, altrimenti undefined. 'error' compreso: chi
 * chiama decide se ricontrollarlo (getFeaturedLyricsAvailability lo rilegge).
 */
export function peekFeaturedLyricsAvailability(
  source: FeaturedLyricsSource,
): FeaturedLyricsAvailability | undefined {
  return cachedAvailability(cacheKey(source));
}

/**
 * Se un brano in evidenza ha un testo e da dove viene, con la STESSA ricerca e la STESSA cache del
 * player (un controllo dall'admin scalda la cache per il player e viceversa). Mai il testo.
 * `source` deve venire da un brano dichiarato con "testo": true: il permesso lo controlla chi
 * chiama (la pagina admin costruisce le fonti dallo stesso elenco dello store e dalla stessa
 * diagnosi di diritti.json). Un esito "lettura fallita" in cache si rilegge subito (il player
 * invece lo tiene ~2 minuti). Non fa mai throw.
 */
export async function getFeaturedLyricsAvailability(
  source: FeaturedLyricsSource,
): Promise<FeaturedLyricsAvailability> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { status: 'error' };
  try {
    const known = cachedAvailability(cacheKey(source));
    if (known && known.status !== 'error') return known;
    return availabilityOf(await cachedLyrics(token, source, true));
  } catch {
    return { status: 'error' };
  }
}
