// @polsia:user-owned — ricerca di brani su audio.com (GET https://api.audio.com/v1/search) per la
// ricerca unificata, con l'account collegato dall'amministratore (audiocom-connection.server.ts).
//
// - Solo `types=audio` e solo la prima pagina (10 risultati: audio.com non ne dà di più per pagina);
//   si tengono le categorie musicali (music, cover, beats).
// - Ogni campo è validato con zod (campi sconosciuti ammessi, voce anomala scartata da sola); gli
//   indirizzi valgono solo se https su audio.com o un suo sottodominio (audiocom-license.ts). Lo
//   stream si tiene SOLO per le licenze riproducibili in Solco (CC0, CC BY, BY-SA, BY-ND) e mai
//   per le cover (la licenza di chi carica non copre la canzone originale).
// - Cache in memoria per query normalizzata: ~10 minuti con risultati, ~1 minuto senza risultati o
//   con un errore di audio.com; al più 500 voci (si toglie la meno usata). Ricerche uguali
//   contemporanee condividono una sola richiesta. NON vanno in cache gli esiti che non dipendono
//   dalla query (pausa dopo un 429, limiti, collegamento assente o token rifiutato): così una
//   raffica di query diverse fermate dai limiti non spinge fuori dalla cache i risultati buoni.
// - audio.com ammette 60 ricerche al minuto PER UTENTE audio.com, e Solco ne usa uno solo per tutti
//   gli ascoltatori. Ogni richiesta che parte davvero (non in cache, non già in corso) consuma
//   prima la quota PERSONALE di chi cerca ('audiocom.search', utente o IP) e poi il limite GLOBALE
//   ('audiocom.search.global', identità 'global', 40 al minuto): una sola persona o uno script non
//   può esaurire da solo il budget di tutti. Senza un'identità affidabile (es. sviluppo locale)
//   nessuna richiesta parte. Oltre la quota personale la fonte è `unavailable` SOLO per chi l'ha
//   superata (`requesterLimited`: la route non mette quella risposta in cache condivisa); oltre il
//   limite globale, con un 429 di audio.com, senza collegamento o con un errore risponde subito
//   `unavailable` o `disconnected`: le altre fonti della ricerca non aspettano mai audio.com.
// I risultati non dipendono da chi cerca (stesso account per tutti): la risposta di search-all
// resta condivisibile in cache. Nessun token nei log.
import 'server-only';
import { z } from 'zod';
import { consumeRateLimit } from '@/lib/business/rate-limit.server';
import {
  AUDIOCOM_MUSIC_CATEGORIES,
  type AudioComSourceStatus,
  type AudioComTrack,
  AudioComTrackSchema,
} from '@/lib/contracts/audiocom';
import {
  AUDIOCOM_API_ORIGIN,
  AudioComError,
  audioComRequest,
  getAudioComAccessToken,
  markAudioComAccessRejected,
  recordAudioComError,
} from '@/lib/music/audiocom-connection.server';
import {
  audioComImageUrl,
  audioComPageUrl,
  audioComStreamUrl,
  isAudioComStreamAllowed,
  normalizeAudioComLicense,
} from '@/lib/music/audiocom-license';
import { normalizeText } from '@/lib/music/unified-search';

export const AUDIOCOM_SEARCH_URL = `${AUDIOCOM_API_ORIGIN}/v1/search`;
export const AUDIOCOM_RATE_LIMIT_IDENTITY = 'global';
export const AUDIOCOM_HIT_TTL_MS = 10 * 60_000;
export const AUDIOCOM_MISS_TTL_MS = 60_000;
export const AUDIOCOM_CACHE_MAX = 500;
/** Tempo massimo della richiesta di ricerca (la route ha il suo, più largo). */
const SEARCH_TIMEOUT_MS = 4_500;
const MAX_BODY_BYTES = 512 * 1024;
/** Pausa dopo un 429 di audio.com senza Retry-After, e tetto a quella dichiarata. */
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 300_000;
/** Query più corte non vanno ad audio.com (sprecherebbero il limite condiviso). */
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 80;

export type AudioComSearchResult = {
  status: AudioComSourceStatus;
  tracks: AudioComTrack[];
  /**
   * true se la ricerca non è partita perché CHI CERCA ha finito la sua quota personale (o manca
   * un'identità affidabile): l'esito vale solo per lui e non va servito ad altri dalla cache.
   */
  requesterLimited?: true;
};

export type AudioComSearchOptions = {
  /** Chi cerca (getRateLimitIdentity: utente o IP d'ingresso), per la quota personale. */
  identity: string | null;
};

const KEPT_CATEGORIES = new Set<string>(AUDIOCOM_MUSIC_CATEGORIES);

const optionalText = z.string().max(2_000).nullish();

/** Il modello Audio dell'API: si leggono solo i campi usati, gli altri sono ammessi e ignorati. */
const RawAudioSchema = z
  .object({
    id: z.union([z.string(), z.number().int().nonnegative()]).transform(String),
    title: optionalText,
    slug: optionalText,
    username: optionalText,
    author_name: optionalText,
    category: optionalText,
    license: optionalText,
    is_listed: z.boolean().nullish(),
    image: optionalText,
    play: z
      .object({ url: optionalText, duration: z.number().finite().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const RawHitSchema = z.object({ type: z.string(), model: z.unknown() }).passthrough();

// biome-ignore lint/suspicious/noControlCharactersInRegex: toglie i caratteri di controllo dai testi.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanText(value: string | null | undefined, max: number): string {
  return (value ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Un risultato grezzo di /v1/search → brano per Solco, o null se non è un brano musicale valido. */
export function toAudioComTrack(hit: unknown): AudioComTrack | null {
  const parsedHit = RawHitSchema.safeParse(hit);
  if (!parsedHit.success || parsedHit.data.type !== 'audio') return null;
  const parsed = RawAudioSchema.safeParse(parsedHit.data.model);
  if (!parsed.success) return null;
  const raw = parsed.data;
  if (raw.is_listed === false) return null;
  const category = cleanText(raw.category, 40).toLowerCase();
  if (!KEPT_CATEGORIES.has(category)) return null;
  const license = normalizeAudioComLicense(raw.license);
  const durationMs = raw.play?.duration ?? 0;
  const candidate = {
    id: raw.id,
    title: cleanText(raw.title, 300),
    authorName: cleanText(raw.author_name, 200) || cleanText(raw.username, 200),
    pageUrl: audioComPageUrl(raw.username, raw.slug),
    imageUrl: audioComImageUrl(raw.image),
    // Lo stream arriva al client SOLO con una licenza riproducibile in Solco e mai per una cover.
    streamUrl: isAudioComStreamAllowed({ license, category })
      ? audioComStreamUrl(raw.play?.url)
      : null,
    durationSeconds:
      durationMs > 0 ? Math.min(86_400, Math.max(1, Math.round(durationMs / 1000))) : null,
    category,
    license,
  };
  const track = AudioComTrackSchema.safeParse(candidate);
  return track.success ? track.data : null;
}

/** Corpo di /v1/search → brani musicali validi (null se il corpo non è un elenco). */
export function parseAudioComSearch(body: unknown): AudioComTrack[] | null {
  if (!Array.isArray(body)) return null;
  const seen = new Set<string>();
  const tracks: AudioComTrack[] = [];
  for (const hit of body) {
    const track = toAudioComTrack(hit);
    if (!track || seen.has(track.id)) continue;
    seen.add(track.id);
    tracks.push(track);
  }
  return tracks;
}

/** Chiave della cache: query normalizzata (minuscolo, senza accenti, spazi compattati). */
export function audioComCacheKey(query: string): string {
  return normalizeText(query).slice(0, MAX_QUERY_LENGTH);
}

type CacheEntry = { expiresAt: number; result: AudioComSearchResult };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<AudioComSearchResult>>();
let cooldownUntil = 0;

/** Svuota cache, richieste in corso e pausa (dopo collega/scollega e nei test). */
export function clearAudioComSearchCache(): void {
  cache.clear();
  inFlight.clear();
  cooldownUntil = 0;
}

function readCache(key: string, now: number): AudioComSearchResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  // LRU: la voce letta torna in fondo (la più recente).
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

function writeCache(key: string, result: AudioComSearchResult, now: number): void {
  const ttl = result.status === 'results' ? AUDIOCOM_HIT_TTL_MS : AUDIOCOM_MISS_TTL_MS;
  cache.delete(key);
  cache.set(key, { expiresAt: now + ttl, result });
  while (cache.size > AUDIOCOM_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

const UNAVAILABLE: AudioComSearchResult = { status: 'unavailable', tracks: [] };
const SKIPPED: AudioComSearchResult = { status: 'skipped', tracks: [] };
const REQUESTER_LIMITED: AudioComSearchResult = {
  status: 'unavailable',
  tracks: [],
  requesterLimited: true,
};

/** Esito di una richiesta ad audio.com e se dipende dalla query (quindi se va in cache). */
type SearchOutcome = { result: AudioComSearchResult; cacheable: boolean };

function retryAfterMs(headers: Headers): number {
  const value = headers.get('retry-after');
  const seconds = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.ceil(seconds) * 1000);
}

async function runSearch(
  query: string,
  access: { token: string; version: number },
): Promise<SearchOutcome> {
  if (Date.now() < cooldownUntil) return { result: UNAVAILABLE, cacheable: false };
  // Limite globale condiviso da tutto Solco: ogni richiesta che parte davvero lo consuma.
  const decision = await consumeRateLimit('audiocom.search.global', AUDIOCOM_RATE_LIMIT_IDENTITY);
  if (!decision.allowed) {
    cooldownUntil = Date.now() + Math.min(60, decision.retryAfterSeconds) * 1000;
    return { result: UNAVAILABLE, cacheable: false };
  }

  const url = new URL(AUDIOCOM_SEARCH_URL);
  url.search = new URLSearchParams({ query, types: 'audio', page: '1' }).toString();
  const result = await audioComRequest(
    url.toString(),
    { headers: { authorization: `Bearer ${access.token}`, accept: 'application/json' } },
    SEARCH_TIMEOUT_MS,
    MAX_BODY_BYTES,
  );
  if (result.status === 401) {
    // Token rifiutato: la prossima ricerca lo rinnova (non dipende dalla query: niente cache).
    await markAudioComAccessRejected(access.version);
    await recordAudioComError('search_unauthorized');
    return { result: UNAVAILABLE, cacheable: false };
  }
  if (result.status === 429) {
    // La pausa vale per tutte le query: niente cache per questa.
    cooldownUntil = Date.now() + retryAfterMs(result.headers);
    await recordAudioComError('rate_limited');
    return { result: UNAVAILABLE, cacheable: false };
  }
  if (!result.ok) {
    await recordAudioComError('search_failed');
    return { result: UNAVAILABLE, cacheable: true };
  }
  const tracks = parseAudioComSearch(result.body);
  if (!tracks) {
    await recordAudioComError('invalid_response');
    return { result: UNAVAILABLE, cacheable: true };
  }
  return { result: { status: tracks.length > 0 ? 'results' : 'empty', tracks }, cacheable: true };
}

function logFailure(error: unknown): void {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
  console.warn(
    '[audiocom] ricerca non riuscita:',
    error instanceof AudioComError
      ? error.reason
      : error instanceof Error
        ? error.name
        : typeof error,
  );
}

/** Risultato già pronto (cache) o ricerca uguale già in corso: gratis per chi cerca. */
function sharedResult(key: string): AudioComSearchResult | Promise<AudioComSearchResult> | null {
  return readCache(key, Date.now()) ?? inFlight.get(key) ?? null;
}

function startSearch(
  key: string,
  query: string,
  access: { token: string; version: number },
): Promise<AudioComSearchResult> {
  const task: Promise<AudioComSearchResult> = runSearch(query, access)
    .catch((error: unknown): SearchOutcome => {
      logFailure(error);
      void recordAudioComError('search_failed');
      return { result: UNAVAILABLE, cacheable: true };
    })
    .then(({ result, cacheable }) => {
      // Una ricerca finita dopo clearAudioComSearchCache (collega/scollega) non riempie la cache.
      if (cacheable && inFlight.get(key) === task) writeCache(key, result, Date.now());
      return result;
    })
    .finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
  inFlight.set(key, task);
  return task;
}

/**
 * Brani musicali di audio.com per `query` (prima pagina). Non lancia mai: in caso di problemi lo
 * stato dice perché (`unavailable`, `disconnected`, `skipped` per una query troppo corta).
 * La quota personale di `identity` si consuma SOLO se parte davvero una richiesta ad audio.com:
 * cache e ricerche uguali già in corso sono gratis.
 */
export async function searchAudioCom(
  query: string,
  options: AudioComSearchOptions,
): Promise<AudioComSearchResult> {
  const text = query.trim().slice(0, MAX_QUERY_LENGTH);
  const key = audioComCacheKey(text);
  if (key.length < MIN_QUERY_LENGTH) return SKIPPED;
  const shared = sharedResult(key);
  if (shared) return shared;
  // Pausa dopo un 429 o dopo il limite globale: nessuna richiesta, nessuna quota consumata.
  if (Date.now() < cooldownUntil) return UNAVAILABLE;
  try {
    const access = await getAudioComAccessToken();
    if (!access.ok) return { status: access.reason, tracks: [] };
    // Solo ora partirebbe una richiesta: prima la quota personale (senza identità affidabile la
    // decisione è sempre negativa, così il budget condiviso non resta mai senza difese).
    const personal = await consumeRateLimit('audiocom.search', options.identity);
    if (!personal.allowed) return REQUESTER_LIMITED;
    // Nel frattempo una ricerca uguale può essere partita o finita: si riusa quella.
    const again = sharedResult(key);
    if (again) return again;
    return startSearch(key, text, access);
  } catch (error) {
    logFailure(error);
    return UNAVAILABLE;
  }
}
