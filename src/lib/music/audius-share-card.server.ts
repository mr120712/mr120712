// @polsia:user-owned — dati della scheda di anteprima di un brano Audius condiviso (?au=<id>):
// titolo, artista e copertina letti da Audius sul server, mai dal link. Così nessuno può far
// disegnare a Solco un'immagine o un testo arbitrari con il marchio del sito.
// - Solo brani che Solco può davvero far ascoltare (playbackEligible, come player e raccolte);
//   titolo e artista passano dallo stesso filtro degli indirizzi web del testo dei link.
// - Una sola richiesta ad Audius per lettura (mai un giro su tutti gli host) e nessuna dopo la
//   scadenza di 4 s: un id inesistente non consuma più posti del budget mensile né della coda
//   condivisa con ricerca, player e trending.
// - Cache in memoria (al massimo ~500 brani: 1 ora se trovato, 5 minuti se non trovato o in
//   errore) e richieste uguali in corso unite in una sola. Le copertine già scaricate restano in
//   memoria un'ora (al massimo 64), così varianti dello stesso indirizzo non le riscaricano.
// - Ogni lettura che arriva davvero ad Audius consuma prima un limite per IP (share.og.audius),
//   poi un tetto giornaliero dell'intera app (share.og.audius.global): oltre l'uno o l'altro, o se
//   il limitatore non risponde, la lettura si salta (scheda generica, senza cache) e il rifiuto non
//   si ricorda, così un indirizzo oltre il suo limite non toglie la scheda agli altri.
import 'server-only';
import { consumeRateLimit } from '@/lib/business/rate-limit.server';
import { audiusTrackIdOrNull, shareCardText } from '@/lib/business/social-share';
import { normalizeAudiusTracks } from '@/lib/music/audius';
import { createAudiusApiClient, reserveAudiusRequestSlot } from '@/lib/music/audius-api.server';
import { getAudiusActivation } from '@/lib/music/audius-source.server';
import { loadOgCover } from '@/lib/og-card.server';

export type AudiusShareCard = { title: string; artist: string; coverUrl: string | null };

const HIT_TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;
const COVER_TTL_MS = 60 * 60 * 1000;
const MAX_COVER_ENTRIES = 64;
/** Tempo massimo della lettura Audius: i crawler dei link non aspettano a lungo l'immagine. */
const LOOKUP_TIMEOUT_MS = 4_000;
export const SHARE_CARD_AUDIUS_ACTION = 'share.og.audius.global' as const;
export const SHARE_CARD_AUDIUS_IP_ACTION = 'share.og.audius' as const;
/** Richieste senza un IP affidabile: un solo limite condiviso, come se fossero un unico indirizzo. */
const UNKNOWN_IDENTITY = 'ip:sconosciuto';

type Entry = { expiresAt: number; card: AudiusShareCard | null };
/** Esito di una lettura: `remember` è false quando non si è chiesto nulla ad Audius. */
type Lookup = { card: AudiusShareCard | null; remember: boolean };
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<AudiusShareCard | null>>();
const covers = new Map<string, { expiresAt: number; dataUrl: string }>();

export function clearAudiusShareCardCacheForTests() {
  cache.clear();
  pending.clear();
  covers.clear();
}

/** Inserisce in fondo (la più recente) e toglie le voci più vecchie oltre `max`. */
function remember<T>(map: Map<string, T>, key: string, value: T, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Un posto nel limite di questo IP e poi nel tetto giornaliero dell'intera app; false se uno dei
 * due è pieno o se il limitatore non risponde.
 */
async function takeBudget(identity: string | null): Promise<boolean> {
  try {
    const own = await consumeRateLimit(SHARE_CARD_AUDIUS_IP_ACTION, identity ?? UNKNOWN_IDENTITY);
    if (!own.allowed) return false;
    const global = await consumeRateLimit(SHARE_CARD_AUDIUS_ACTION, 'global');
    return global.allowed;
  } catch {
    return false;
  }
}

/** Il brano letto da Audius (una sola richiesta), o null se manca, non è ascoltabile o va male. */
async function readTrack(
  id: string,
  apiKey: string,
  timeoutMs: number,
): Promise<AudiusShareCard | null> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let fetches = 0;
  let reserved = false;
  const client = createAudiusApiClient({
    apiKey,
    // Una sola richiesta, mai dopo la scadenza; ognuna si interrompe anche alla scadenza.
    // get() del client prova un host dopo l'altro se il primo non risponde 2xx: qui dal secondo
    // tentativo il fetcher rifiuta senza andare in rete, così il ciclo finisce subito.
    fetcher: (input, init) => {
      fetches += 1;
      if (fetches > 1 || deadline.aborted) {
        return Promise.reject(new Error('Una sola richiesta ad Audius per anteprima.'));
      }
      return fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      });
    },
    // Solo il primo tentativo prende un posto vero del budget mensile e della coda condivisa; gli
    // altri (rifiutati dal fetcher) non costano nulla. Così get() arriva comunque in fondo e
    // registra l'eventuale attesa chiesta da Audius con un 429 (vale per tutta l'app).
    reserve: async () => {
      if (reserved) return { allowed: true, notBefore: 0 };
      if (deadline.aborted) {
        return { allowed: false, reason: 'rate_limited', retryAfterSeconds: 1 };
      }
      reserved = true;
      return reserveAudiusRequestSlot();
    },
    // Nessuna ricerca del registro degli host: si usa l'host che ha risposto per ultimo all'app
    // (o il primo host noto di Audius).
    hostResolver: async () => [],
  });
  const timeout = new Promise<never>((_, reject) => {
    if (deadline.aborted) reject(new Error('timeout'));
    deadline.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  });
  timeout.catch(() => undefined);
  const payload = await Promise.race([client.getTrack(id), timeout]);
  const track = normalizeAudiusTracks(payload, true).find((item) => item.id === id);
  // Solo brani che Solco può far ascoltare (licenza OML, disponibili, non riservati).
  if (!track?.playbackEligible || !track.artistName) return null;
  const title = shareCardText(track.title, 'title');
  const artist = shareCardText(track.artistName, 'artist');
  if (!title || !artist) return null;
  return { title, artist, coverUrl: track.artworkUrl ?? null };
}

async function lookup(id: string, identity: string | null, timeoutMs: number): Promise<Lookup> {
  const activation = getAudiusActivation();
  if (!activation.active) return { card: null, remember: false };
  if (!(await takeBudget(identity))) return { card: null, remember: false };
  try {
    return { card: await readTrack(id, activation.apiKey, timeoutMs), remember: true };
  } catch {
    return { card: null, remember: true };
  }
}

/**
 * Titolo, artista e copertina del brano Audius `trackId` per la scheda di anteprima, o null se
 * l'id non è valido, Audius non è configurato, il brano non esiste, non è ascoltabile su Solco o
 * non è leggibile ora. `identity` è l'IP della richiesta (getRateLimitIdentity), per il limite
 * per indirizzo delle letture vere; `timeoutMs` serve solo ai test.
 */
export async function getAudiusShareCard(
  trackId: string,
  options: { identity?: string | null; now?: number; timeoutMs?: number } = {},
): Promise<AudiusShareCard | null> {
  const id = audiusTrackIdOrNull(trackId);
  if (!id) return null;
  const now = options.now ?? Date.now();
  const cached = cache.get(id);
  if (cached && cached.expiresAt > now) return cached.card;
  if (cached) cache.delete(id);

  const running = pending.get(id);
  if (running) return running;
  const result = lookup(id, options.identity ?? null, options.timeoutMs ?? LOOKUP_TIMEOUT_MS)
    .then(({ card, remember: keep }) => {
      if (keep) {
        const expiresAt = Date.now() + (card ? HIT_TTL_MS : MISS_TTL_MS);
        remember(cache, id, { card, expiresAt }, MAX_ENTRIES);
      }
      return card;
    })
    .catch(() => null)
    .finally(() => {
      pending.delete(id);
    });
  pending.set(id, result);
  return result;
}

/**
 * La copertina (indicata da Audius) pronta per la scheda: data URL JPEG di `box`×`box`, o null.
 * Le copertine riuscite restano in memoria un'ora; quelle non riuscite si riprovano.
 */
export async function getAudiusShareCover(
  coverUrl: string,
  box: number,
  background: string,
  now = Date.now(),
): Promise<string | null> {
  const key = `${box}|${background}|${coverUrl}`;
  const cached = covers.get(key);
  if (cached && cached.expiresAt > now) return cached.dataUrl;
  if (cached) covers.delete(key);
  const dataUrl = await loadOgCover(coverUrl, box, { background });
  if (dataUrl) {
    remember(covers, key, { dataUrl, expiresAt: Date.now() + COVER_TTL_MS }, MAX_COVER_ENTRIES);
  }
  return dataUrl;
}
