// @polsia:user-owned — condivisione sui social da parte degli utenti: semplici link alle pagine di
// condivisione dei servizi (nessun SDK, nessuno script di terzi, nessun dato inviato da Solco).
// Chi tocca il link apre WhatsApp, Telegram, X, Facebook o l'email con testo e link già pronti.
// Modulo puro (client e server): link dei brani, lettura dei loro parametri e indirizzo canonico
// della scheda di anteprima (search/anteprima.jpg). Nessun URL di immagine viaggia nei link.
import { publicSiteUrl } from '@/lib/public-links';

export type SocialShareTarget = {
  id: 'whatsapp' | 'telegram' | 'x' | 'facebook' | 'email';
  label: string;
  href: string;
};

/**
 * encodeURIComponent lascia ! ' ( ) * ~: qui diventano %XX, così il link è accettato anche come
 * destinazione dopo l'accesso (better-auth rifiuta questi caratteri, es. "Help!" o "P!nk").
 */
export function strictEncode(value: string) {
  return encodeURIComponent(value.replace(LONE_SURROGATE, '�')).replace(
    /[!'()*~]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Metà di emoji rimaste sole (dati sporchi): encodeURIComponent le rifiuterebbe con un errore. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Spazi compattati e lunghezza limitata (il testo finisce in un URL). Il taglio è per caratteri
 * interi: tagliare a metà un'emoji lascerebbe un surrogato solo e la codifica fallirebbe.
 * Idempotente: tidy(tidy(x, n), n) === tidy(x, n).
 */
function tidy(value: string, max: number) {
  const clean = value.replace(LONE_SURROGATE, '�').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, max).join('').trim();
}

/**
 * Indirizzi web dentro un testo (titolo o artista di un link o di Audius):
 * - con schema o "www." ovunque, anche attaccati a una parola ("_https://…", "1www.…");
 * - domini senza schema seguiti da un percorso ("sito.example/login");
 * - domini senza schema con un suffisso molto usato ("evil.com", "solco-chiude.it").
 * Volutamente non tocca nomi come "will.i.am", "Vol.II" o "Mr.Brightside".
 */
const LINK_LIKE =
  /(?:https?:\/\/|www\.)\S*|[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.(?:[a-z]{2,24}\/\S*|(?:com|net|org|info|biz|io|it|eu|co|me|ly|gg|tv|app|dev|xyz|top|online|site|link|click|shop|store|ru|cn)(?![\p{L}\p{N}_-])\S*)/giu;

/**
 * Toglie gli indirizzi web finché non ne resta nessuno: togliendone uno, il testo rimasto può
 * formarne un altro ("a.comhttps://x" → "a.com"). Ogni giro accorcia il testo, quindi finisce.
 */
function withoutLinks(value: string) {
  let text = value;
  for (;;) {
    const next = text.replace(LINK_LIKE, ' ').replace(/\s+/g, ' ').trim();
    if (next === text) return text;
    text = next;
  }
}

/**
 * Testo libero di un link condiviso pronto per la scheda e per i metadati della pagina: compatto,
 * limitato e senza nulla che sembri un indirizzo web (nessuno può far "consigliare" un sito da una
 * scheda di Solco). Prima il taglio, poi la pulizia: il risultato è lo stesso partendo dal testo
 * intero o da quello già tagliato nel link, ed è idempotente (l'indirizzo canonico non cambia).
 */
function cardText(value: string, max: number) {
  return tidy(withoutLinks(tidy(value, max)), max);
}

/** Link di condivisione per i social principali (Instagram e TikTok passano dal menu del telefono). */
export function socialShareLinks(input: {
  url: string;
  text: string;
  title?: string;
}): SocialShareTarget[] {
  const url = input.url.replace(LONE_SURROGATE, '�').trim();
  const text = tidy(input.text, 280);
  const subject = tidy(input.title ?? 'Solco', 120);
  const enc = encodeURIComponent;
  return [
    { id: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${enc(`${text} ${url}`)}` },
    {
      id: 'telegram',
      label: 'Telegram',
      href: `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`,
    },
    { id: 'x', label: 'X', href: `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}` },
    {
      id: 'facebook',
      label: 'Facebook',
      href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    },
    {
      id: 'email',
      label: 'Email',
      href: `mailto:?subject=${enc(subject)}&body=${enc(`${text}\n\n${url}`)}`,
    },
  ];
}

/** Indirizzo pubblico (sito ufficiale) per un percorso di Solco, es. "/generi/rock". */
export function publicShareUrl(path: string, base = publicSiteUrl()): string {
  return new URL(path, `${base}/`).toString();
}

/** Lunghezze massime di titolo e artista nel link e nell'anteprima. */
const SHARED_TITLE_MAX = 120;
const SHARED_ARTIST_MAX = 80;
/** Lunghezza massima della ricerca (q), come la pagina /search. */
const SHARED_QUERY_MAX = 80;
/**
 * Un link condiviso resta sotto questa lunghezza: chi non ha un account passa dall'accesso e la
 * destinazione (al massimo 2048 caratteri, vedi auth-form) deve contenerlo. Oltre, si tolgono
 * prima l'artista e poi il titolo; la ricerca (q) e l'id Audius restano sempre.
 */
export const SONG_SHARE_URL_MAX = 1800;

/** Id di un brano Audius (come in collections.server e normalizeAudiusTracks). */
const AUDIUS_TRACK_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** L'id se è un id di brano Audius valido, altrimenti null. */
export function audiusTrackIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && AUDIUS_TRACK_ID.test(value) ? value : null;
}

/**
 * L'id Audius di un brano del player ("audius:<id>"), mai di una playlist o di un album
 * ("audius:playlist:…", "audius:album:…": i due punti non sono ammessi in un id). null altrimenti.
 */
export function audiusTrackIdFromQualifiedId(
  qualifiedId: string | null | undefined,
): string | null {
  if (!qualifiedId?.startsWith('audius:')) return null;
  return audiusTrackIdOrNull(qualifiedId.slice('audius:'.length));
}

/**
 * Link per condividere un brano: la ricerca di Solco con artista e titolo (funziona per ogni fonte;
 * chi non ha ancora un account passa dall'accesso e torna qui). Porta anche titolo e artista per
 * il titolo dell'anteprima social e, per un brano Audius, il suo id (au): la scheda con copertina,
 * titolo e artista la disegna il server leggendo il brano da Audius, mai da un URL del link.
 */
export function songShareUrl(
  title: string,
  artist: string | null,
  base = publicSiteUrl(),
  audiusId?: string | null,
): string {
  const query = `q=${strictEncode(tidy(`${artist ?? ''} ${title}`, SHARED_QUERY_MAX))}`;
  const titleParam = `t=${strictEncode(tidy(title, SHARED_TITLE_MAX))}`;
  const cleanArtist = tidy(artist ?? '', SHARED_ARTIST_MAX);
  const artistParam = cleanArtist ? `a=${strictEncode(cleanArtist)}` : null;
  const id = audiusTrackIdOrNull(audiusId);
  const idParam = id ? `au=${id}` : null;
  const build = (...params: Array<string | null>) =>
    publicShareUrl(`/search?${params.filter(Boolean).join('&')}`, base);

  const full = build(query, titleParam, artistParam, idParam);
  if (full.length <= SONG_SHARE_URL_MAX) return full;
  const withoutArtist = build(query, titleParam, idParam);
  if (withoutArtist.length <= SONG_SHARE_URL_MAX) return withoutArtist;
  return build(query, idParam);
}

/**
 * Il brano descritto da un link condiviso. `title` e `artist` sono testo libero già pulito
 * (cardText); `audiusId` è l'id Audius del link, che il server verifica prima di usarlo.
 */
export type SharedSongCard = { title: string; artist: string | null; audiusId: string | null };

type ParamRecord = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : '';
}

/**
 * I parametri di un URL nella stessa forma dei searchParams di una pagina Next (un parametro
 * ripetuto diventa un array): la rotta dell'immagine e la pagina leggono il link allo stesso modo.
 */
export function searchParamsRecord(params: URLSearchParams): ParamRecord {
  const record: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    const previous = record[key];
    record[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return record;
}

/**
 * Il brano di un link condiviso (parametri t, a, au; q se manca il titolo), per l'anteprima
 * social. null se il link non descrive un brano. Un vecchio parametro img (URL di copertina) è
 * ignorato: nessuna immagine arriva mai dal link.
 */
export function sharedSongFromParams(params: ParamRecord): SharedSongCard | null {
  const title = cardText(firstParam(params.t) || firstParam(params.q), SHARED_TITLE_MAX);
  const audiusId = audiusTrackIdOrNull(firstParam(params.au));
  if (!title && !audiusId) return null;
  const artist = cardText(firstParam(params.a), SHARED_ARTIST_MAX) || null;
  return { title, artist, audiusId };
}

/**
 * Percorso canonico della pagina di un brano condiviso (og:url di search/page.tsx e
 * dell'anteprima in modalità attacco): il link ricostruito da songShareUrl, o null senza titolo
 * (un link con il solo id Audius resta com'è).
 */
export function sharedSongPagePath(song: SharedSongCard | null): string | null {
  if (!song?.title) return null;
  const { pathname, search } = new URL(
    songShareUrl(song.title, song.artist, undefined, song.audiusId),
  );
  return `${pathname}${search}`;
}

/**
 * Titolo o artista di un brano (anche letti da Audius, dove chiunque può caricare un brano) pronti
 * per la scheda: stesse regole del testo dei link, quindi nessun indirizzo web disegnato.
 */
export function shareCardText(value: string, kind: 'title' | 'artist'): string {
  return cardText(value, kind === 'title' ? SHARED_TITLE_MAX : SHARED_ARTIST_MAX);
}

/** Percorso della scheda generica (nessun brano): senza query. */
export const SONG_PREVIEW_IMAGE_BASE = '/search/anteprima.jpg';

/**
 * Indirizzo canonico dell'immagine di anteprima (JPEG 1200×630) di un brano condiviso. Pulisce
 * da sé i suoi dati, così il player e la pagina ottengono lo stesso identico indirizzo per lo
 * stesso brano (una sola voce nella CDN). Con un id Audius solo ?au=<id> (titolo, artista e
 * copertina arrivano da Audius); senza, ?t=…&a=… in quest'ordine (a facoltativo).
 */
export function songPreviewImagePath(
  song: { title?: string | null; artist?: string | null; audiusId?: string | null } | null,
): string {
  const audiusId = audiusTrackIdOrNull(song?.audiusId);
  if (audiusId) return `${SONG_PREVIEW_IMAGE_BASE}?au=${audiusId}`;
  const title = cardText(song?.title ?? '', SHARED_TITLE_MAX);
  if (!title) return SONG_PREVIEW_IMAGE_BASE;
  const artist = cardText(song?.artist ?? '', SHARED_ARTIST_MAX);
  const params = [`t=${strictEncode(title)}`];
  if (artist) params.push(`a=${strictEncode(artist)}`);
  return `${SONG_PREVIEW_IMAGE_BASE}?${params.join('&')}`;
}

/**
 * L'immagine di anteprima di un link creato da songShareUrl: la stessa che la pagina /search
 * mette in og:image per quel link (stessa lettura dei parametri, stesso indirizzo canonico).
 */
export function songShareImagePath(shareUrl: string): string {
  try {
    const params = searchParamsRecord(new URL(shareUrl, 'https://solco.invalid').searchParams);
    return songPreviewImagePath(sharedSongFromParams(params));
  } catch {
    return SONG_PREVIEW_IMAGE_BASE;
  }
}

/** Testo per condividere ciò che si sta ascoltando. */
export function songShareText(title: string, artist: string | null, live = false): string {
  const name = tidy(title, 120);
  const by = artist ? ` di ${tidy(artist, 80)}` : '';
  return live ? `Sto ascoltando ${name} su Solco.` : `Sto ascoltando «${name}»${by} su Solco.`;
}
