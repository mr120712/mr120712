// @polsia:user-owned — Under Attack Mode: la paginetta di soli meta tag (Open Graph, Twitter) che
// i bot delle anteprime dei link (WhatsApp, Telegram, X, Facebook, …) ricevono in modalità attacco
// al posto della schermata di verifica, che non saprebbero risolvere. Senza di lei un link
// condiviso durante un attacco mostrerebbe solo «Solco» e le piattaforme terrebbero in cache
// quell'anteprima vuota.
//
// Nessuno script, nessuno stile, nessun render dell'app: solo testo scappato e URL assoluti. Gira
// dentro il proxy (src/proxy.ts → uam-gate.ts): niente 'server-only', niente API solo Node, niente
// React. Le immagini indicate (/opengraph-image, /search/anteprima.*, /playlist/<id>/anteprima.*)
// sono escluse dal gate (isGateablePath in uam.ts), così il bot le può scaricare.
import { siteDescription, siteName } from '@/lib/brand';
import { sharedSongFromParams, songPreviewImagePath } from '@/lib/business/social-share';
import { isShareId, sharedPlaylistImagePath } from '@/lib/music/playlist-share';

export interface LinkPreview {
  title: string;
  description: string;
  /** URL assoluto dell'immagine (1200×630). */
  image: string;
  imageAlt: string;
  /** URL assoluto della pagina condivisa. */
  url: string;
  type: 'website' | 'music.song' | 'music.playlist';
}

/** Stessi testi dei metadati delle pagine (search/page.tsx, playlist/[shareId]/page.tsx). */
const SONG_DESCRIPTION = 'Ascoltalo su Solco: musica, radio dal vivo e podcast in un solo player.';
const SONG_FALLBACK_TITLE = 'Un brano su Solco';
const PLAYLIST_TITLE = 'Playlist condivisa su Solco';
const PLAYLIST_DESCRIPTION =
  'Una playlist condivisa su Solco: ascoltala gratis e salvala nella tua Libreria.';

/** Tutte le immagini di anteprima di Solco sono 1200×630. */
const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 630;

const PLAYLIST_PATH = /^\/playlist\/([^/]+)$/;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S*/gi;

/**
 * CSP della paginetta: non carica e non esegue nulla (i meta tag non sono risorse). Il bot legge
 * l'HTML, poi scarica l'immagine con una richiesta sua.
 */
export const LINK_PREVIEW_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Toglie dal testo libero (titolo e artista arrivano dal link, li sceglie chi lo crea) tutto ciò
 * che sembra un indirizzo web, così l'anteprima di Solco non diventa una vetrina per link altrui.
 */
export function stripUrlLikeText(text: string): string {
  return text.replace(URL_LIKE, ' ').replace(/\s+/g, ' ').trim();
}

/** Testo sicuro dentro un elemento o un attributo HTML tra virgolette doppie. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** URL assoluto per un percorso di Solco: sempre sull'origine `base`, mai su un altro host. */
function absolute(base: string, path: string): string {
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** La parte dell'URL richiesto che serve qui (URL o request.nextUrl). */
export type PreviewUrl = Pick<URL, 'pathname' | 'search' | 'searchParams'>;

/** I parametri della query nella forma di searchParams di Next (più valori → array). */
function queryParams(url: PreviewUrl): Record<string, string | string[]> {
  const entries: [string, string | string[]][] = [];
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    entries.push([key, values.length === 1 ? (values[0] ?? '') : values]);
  }
  // fromEntries crea proprietà proprie: una chiave "__proto__" resta una chiave qualsiasi.
  return Object.fromEntries(entries);
}

function siteLinkPreview(base: string, pageUrl: string): LinkPreview {
  return {
    title: siteName,
    description: siteDescription,
    image: absolute(base, '/opengraph-image'),
    imageAlt: siteName,
    url: pageUrl,
    type: 'website',
  };
}

function songLinkPreview(url: PreviewUrl, base: string, pageUrl: string): LinkPreview | null {
  const song = sharedSongFromParams(queryParams(url));
  if (!song) return null;
  // social-share pulisce già il testo; ripulirlo qui costa poco e non dipende da quel contratto.
  const title = stripUrlLikeText(song.title);
  const artist = song.artist ? stripUrlLikeText(song.artist) || null : null;
  // L'immagine riceve gli stessi testi ripuliti dell'anteprima.
  const imagePath = songPreviewImagePath({ ...song, title, artist });
  // Senza titolo resta solo un link con l'id del brano (l'immagine lo legge sul server): titolo
  // generico. Senza titolo né brano (immagine senza parametri): la scheda di Solco.
  if (!title && !imagePath.includes('?')) return null;
  const label = title ? (artist ? `${title} · ${artist}` : title) : SONG_FALLBACK_TITLE;
  return {
    title: label,
    description: SONG_DESCRIPTION,
    image: absolute(base, imagePath),
    imageAlt: label,
    url: pageUrl,
    type: 'music.song',
  };
}

/**
 * Titolo, descrizione e immagine dell'anteprima per l'URL richiesto: un brano condiviso
 * (/search con i parametri del brano), una playlist condivisa (/playlist/<shareId>) o, per ogni
 * altra pagina, la scheda generica di Solco. `base` è l'origine pubblica (senza slash finale).
 */
export function linkPreviewFor(url: PreviewUrl, base: string): LinkPreview {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : url.pathname;
  const pageUrl = absolute(base, `${url.pathname}${url.search}`);

  if (path === '/search') {
    return songLinkPreview(url, base, pageUrl) ?? siteLinkPreview(base, pageUrl);
  }

  const shareId = PLAYLIST_PATH.exec(path)?.[1];
  if (shareId !== undefined && isShareId(shareId)) {
    return {
      title: PLAYLIST_TITLE,
      description: PLAYLIST_DESCRIPTION,
      image: absolute(base, sharedPlaylistImagePath(shareId)),
      imageAlt: PLAYLIST_TITLE,
      url: pageUrl,
      type: 'music.playlist',
    };
  }

  return siteLinkPreview(base, pageUrl);
}

/** La paginetta HTML: solo meta tag, ogni valore scappato. */
export function renderLinkPreviewPage(preview: LinkPreview): string {
  const meta = (attribute: 'name' | 'property', key: string, value: string | number) =>
    `<meta ${attribute}="${key}" content="${escapeHtml(String(value))}">`;
  return [
    '<!doctype html>',
    '<html lang="it">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(preview.title)}</title>`,
    meta('name', 'description', preview.description),
    meta('name', 'robots', 'noindex'),
    meta('property', 'og:site_name', siteName),
    meta('property', 'og:locale', 'it_IT'),
    meta('property', 'og:type', preview.type),
    meta('property', 'og:title', preview.title),
    meta('property', 'og:description', preview.description),
    meta('property', 'og:url', preview.url),
    meta('property', 'og:image', preview.image),
    meta('property', 'og:image:width', IMAGE_WIDTH),
    meta('property', 'og:image:height', IMAGE_HEIGHT),
    meta('property', 'og:image:alt', preview.imageAlt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', preview.title),
    meta('name', 'twitter:description', preview.description),
    meta('name', 'twitter:image', preview.image),
    '</head>',
    '<body></body>',
    '</html>',
  ].join('\n');
}
