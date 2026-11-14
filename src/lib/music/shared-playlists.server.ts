// @polsia:user-owned — playlist condivise con un link pubblico (/playlist/<shareId>): creazione
// dell'id, lettura anonima (solo i campi del player e la descrizione, metadati YouTube scaduti
// omessi), descrizione per l'anteprima dei link (og:description, senza indirizzi web, letta col
// budget per IP delle anteprime) e copertine Audius per l'anteprima social (mai miniature YouTube).
import 'server-only';
import { randomBytes } from 'node:crypto';
import { headers } from 'next/headers';
import { consumeRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { publicShareUrl } from '@/lib/business/social-share';
import { prisma } from '@/lib/db';
import {
  MAX_ITEMS_PER_COLLECTION,
  withoutExpiredYouTubeMetadata,
} from '@/lib/music/collections.server';
import {
  clipWithEllipsis,
  isShareId,
  normalizePlaylistDescription,
  PLAYLIST_DESCRIPTION_MAX_LENGTH,
  SHARED_PLAYLIST_META_DESCRIPTION_MAX_LENGTH,
  sharedPlaylistOwnerName,
  sharedPlaylistPath,
} from '@/lib/music/playlist-share';
import { isShareableCoverUrl } from '@/lib/music/shareable-cover';
import { stripUrlLikeText } from '@/lib/security/uam-preview';

/** 16 byte da crypto in base64url: 22 caratteri, non indovinabili né enumerabili. */
export function generateShareId() {
  return randomBytes(16).toString('base64url');
}

/** Il link da condividere: sempre sul sito pubblico (publicSiteUrl), come i link dei brani. */
export function sharedPlaylistUrl(shareId: string) {
  return publicShareUrl(sharedPlaylistPath(shareId));
}

// No row id: the public page keys items by `source:sourceId` (unique in a collection).
const sharedItemSelect = {
  source: true,
  sourceId: true,
  title: true,
  creatorName: true,
  artworkUrl: true,
  sourceUrl: true,
  artistUrl: true,
  durationSeconds: true,
  createdAt: true,
  expiresAt: true,
} as const;

/** Il proprietario di una playlist condivisa, se esiste ancora e non è stato bannato. */
async function availableOwner(userId: string) {
  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, banned: true },
  });
  return owner && owner.banned !== true ? owner : null;
}

/**
 * La playlist condivisa con questo id, con gli elementi nello stesso ordine della Libreria del
 * proprietario (più recenti prima) e i metadati YouTube scaduti già rimossi. null se l'id non ha
 * il formato giusto (nessuna query), non esiste, la playlist non è più condivisa oppure il
 * proprietario non esiste più o è stato bannato (come findAvailableUsers della community).
 */
export async function findSharedCollection(shareId: string, now = new Date()) {
  if (!isShareId(shareId)) return null;
  const collection = await prisma.userMusicCollection.findFirst({
    where: { shareId },
    select: {
      name: true,
      description: true,
      kind: true,
      userId: true,
      sharedAt: true,
      updatedAt: true,
      items: {
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: MAX_ITEMS_PER_COLLECTION,
        select: sharedItemSelect,
      },
    },
  });
  if (!collection || collection.kind !== 'playlist' || !collection.sharedAt) return null;
  const owner = await availableOwner(collection.userId);
  if (!owner) return null;
  return {
    ...collection,
    ownerName: owner.name,
    items: collection.items.map((item) => withoutExpiredYouTubeMetadata(item, now)),
  };
}

/** La descrizione come la mostra la pagina pubblica: ripulita, entro 300 caratteri, o null. */
function publicDescription(description: string | null | undefined) {
  const cleaned = normalizePlaylistDescription(description);
  return cleaned ? clipWithEllipsis(cleaned, PLAYLIST_DESCRIPTION_MAX_LENGTH) : null;
}

/** Fonti che il player e la pagina pubblica sanno mostrare (come la Libreria). */
const PUBLIC_SOURCES = new Set(['audius', 'youtube', 'song']);

/**
 * Risposta pubblica di GET /api/music/shared/[shareId]: nessun userId, email, id della raccolta o
 * dei suoi elementi.
 */
export async function getSharedPlaylist(shareId: string, now = new Date()) {
  const collection = await findSharedCollection(shareId, now);
  if (!collection) return null;
  // Adding or removing a song does not touch the playlist row: the newest item counts too.
  const newestItem = collection.items.reduce<Date | null>(
    (latest, item) => (!latest || item.createdAt > latest ? item.createdAt : latest),
    null,
  );
  const updatedAt =
    newestItem && newestItem > collection.updatedAt ? newestItem : collection.updatedAt;
  const items = collection.items.filter((item) => PUBLIC_SOURCES.has(item.source));
  return {
    name: collection.name,
    owner: sharedPlaylistOwnerName(collection.ownerName),
    // Testo semplice: ripulito di nuovo in lettura e mai oltre il limite del contratto.
    description: publicDescription(collection.description),
    itemCount: items.length,
    items: items.map((item) => ({
      source: item.source,
      sourceId: item.sourceId,
      title: item.title,
      creatorName: item.creatorName,
      artworkUrl: item.artworkUrl,
      sourceUrl: item.sourceUrl,
      artistUrl: item.artistUrl,
      durationSeconds: item.durationSeconds,
    })),
    updatedAt: updatedAt.toISOString(),
  };
}

// La regola delle copertine condivisibili vive in un modulo puro (shareable-cover), testabile da
// solo. I brani condivisi non la usano: la loro copertina arriva da Audius, mai dal link.
export { isShareableCoverUrl } from '@/lib/music/shareable-cover';

/** Fino a `limit` copertine Audius diverse, nell'ordine della playlist: mai elementi YouTube. */
export function sharedPlaylistCovers(
  items: ReadonlyArray<{ source: string; artworkUrl: string | null }>,
  limit = 4,
): string[] {
  const covers: string[] = [];
  for (const item of items) {
    if (covers.length >= limit) break;
    if (
      item.source === 'audius' &&
      isShareableCoverUrl(item.artworkUrl) &&
      !covers.includes(item.artworkUrl)
    ) {
      covers.push(item.artworkUrl);
    }
  }
  return covers;
}

/**
 * Indirizzi senza schema né www («bit.ly/abc», «solco-premium.it/rinnovo», «mario@evil.com»,
 * «203.0.113.5/x»): etichette unite da punti (anche il punto ideografico, che i browser accettano
 * negli host) e un'ultima etichetta da dominio di primo livello (lettere latine o xn--), con
 * eventuali porta, percorso o query. Si cerca sul testo già in NFKC, dove le lettere a larghezza
 * piena (ｅｖｉｌ．ｃｏｍ) sono diventate normali. Qualche abbreviazione senza spazio («sig.ra»)
 * sparisce dall'anteprima: meglio che un link travestito; la pagina mostra comunque il testo intero.
 */
const HOST_LIKE =
  /(?:[\p{L}\p{N}._%+-]+@)?(?:(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?[.。])+(?:[a-z]{2,63}|xn--[a-z0-9-]+)|\d{1,3}(?:\.\d{1,3}){3})(?![\p{L}\p{N}-])(?:[:/?#]\S*)?/giu;

/**
 * og:description di una playlist condivisa a partire dalla descrizione del proprietario: su una
 * sola riga, senza nulla che sembri un indirizzo web (la pulizia dell'anteprima in modalità
 * attacco, stripUrlLikeText, più gli indirizzi senza schema e quelli a larghezza piena: l'anteprima
 * di Solco non diventa una vetrina per link altrui) e al massimo 160 unità UTF-16. null se non
 * resta testo leggibile: la pagina usa la descrizione generica.
 */
export function sharedPlaylistMetaDescription(description: string | null | undefined) {
  // NFKC prima della pulizia: le forme a larghezza piena tornano ASCII, e ciò che NFKC dovesse
  // far comparire di invisibile viene tolto subito dopo.
  const cleaned = normalizePlaylistDescription(
    typeof description === 'string' ? description.normalize('NFKC') : null,
  );
  if (!cleaned) return null;
  const text = stripUrlLikeText(cleaned).replace(HOST_LIKE, ' ').replace(/\s+/g, ' ').trim();
  // Resta solo punteggiatura (il testo era fatto di link): meglio la descrizione generica.
  if (!/[\p{L}\p{N}\p{S}]/u.test(text)) return null;
  return clipWithEllipsis(text, SHARED_PLAYLIST_META_DESCRIPTION_MAX_LENGTH);
}

/** Per quanto la descrizione per l'anteprima resta in memoria: come la cache CDN della lettura. */
const META_DESCRIPTION_TTL_MS = 60_000;
const META_DESCRIPTION_CACHE_LIMIT = 500;
const metaDescriptionCache = new Map<string, { value: string | null; expiresAt: number }>();

/**
 * La descrizione per i metadati della pagina /playlist/<shareId> (og:description), o null se la
 * playlist non ha descrizione, non è condivisa, è dei Preferiti o il proprietario non è
 * disponibile: le stesse regole della lettura pubblica, ma senza leggere gli elementi. Un id
 * malformato non arriva al database. Ogni istanza ricorda la risposta per 60 secondi (come la
 * cache CDN della lettura pubblica): richieste ripetute alla stessa pagina non interrogano il
 * database ogni volta. Si ricordano solo le playlist che esistono: id inventati non spingono fuori
 * quelle vere. Gli errori non vengono ricordati. `mayReadDatabase` viene chiesto solo prima di una
 * lettura vera (mai per un id malformato o già in memoria): false = null, senza leggere.
 */
export async function getSharedPlaylistMetaDescription(
  shareId: string,
  now = Date.now(),
  mayReadDatabase: () => Promise<boolean> = async () => true,
) {
  if (!isShareId(shareId)) return null;
  const cached = metaDescriptionCache.get(shareId);
  if (cached && cached.expiresAt > now) return cached.value;
  if (!(await mayReadDatabase())) return null;
  const collection = await prisma.userMusicCollection.findFirst({
    where: { shareId },
    select: { description: true, kind: true, sharedAt: true, userId: true },
  });
  if (!collection) return null;
  const available =
    collection.kind === 'playlist' &&
    Boolean(collection.sharedAt) &&
    Boolean(collection.description) &&
    (await availableOwner(collection.userId)) !== null;
  const value = available ? sharedPlaylistMetaDescription(collection.description) : null;
  if (metaDescriptionCache.size >= META_DESCRIPTION_CACHE_LIMIT) {
    for (const [key, entry] of metaDescriptionCache) {
      if (entry.expiresAt <= now) metaDescriptionCache.delete(key);
    }
    // Ancora piena: fa posto la voce più vecchia (Map conserva l'ordine di inserimento).
    if (metaDescriptionCache.size >= META_DESCRIPTION_CACHE_LIMIT) {
      const oldest = metaDescriptionCache.keys().next().value;
      if (oldest !== undefined) metaDescriptionCache.delete(oldest);
    }
  }
  metaDescriptionCache.delete(shareId);
  metaDescriptionCache.set(shareId, { value, expiresAt: now + META_DESCRIPTION_TTL_MS });
  return value;
}

/**
 * La descrizione per i metadati della pagina /playlist/<shareId> nella richiesta in corso: ogni
 * lettura del database consuma il budget per IP delle anteprime dei link (share.og, lo stesso di
 * anteprima.jpg). Limite raggiunto, limitatore che non risponde o IP sconosciuto: null, senza
 * leggere, e la pagina usa la descrizione generica. Una risposta già in memoria non consuma nulla.
 */
export function getSharedPlaylistPreviewDescription(shareId: string) {
  return getSharedPlaylistMetaDescription(shareId, Date.now(), async () => {
    try {
      const identity = getRateLimitIdentity(null, await headers());
      return (await consumeRateLimit('share.og', identity)).allowed;
    } catch {
      return false;
    }
  });
}
