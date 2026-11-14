// @polsia:user-owned — link diretto «Condividi» dei brani in evidenza DICHIARATI in diritti.json
// (logica pura, client, server e proxy): forma dell'id opaco, percorsi della pagina pubblica
// /evidenza/<id>, della sua scheda di anteprima (JPEG 1200×630), dell'API e della copertina, e i
// testi della condivisione. L'id lo calcola SOLO il server (featured-share.server: HMAC del
// pathname con un segreto del server), quindi un link non rivela mai il pathname del file nello
// store e non si può costruire per un brano non dichiarato: quei link non esistono (404).
import { shareCardText } from '@/lib/business/social-share';

/** Lunghezza dell'id: 22 caratteri base64url (132 bit dell'HMAC). */
export const FEATURED_SHARE_ID_LENGTH = 22;
/** Forma di un id di condivisione valido: 22 caratteri [A-Za-z0-9_-]. */
export const FEATURED_SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Prefisso della pagina pubblica di un brano condiviso. */
export const FEATURED_SHARE_PAGE_PREFIX = '/evidenza/';
/** Prefisso dell'API del brano condiviso (metadati; con una sessione anche il brano da ascoltare). */
export const FEATURED_SHARE_API_PREFIX = '/api/music/featured/tracks/';

/** og:description della pagina (e dell'anteprima in modalità attacco). */
export const FEATURED_SHARE_DESCRIPTION = 'Ascoltalo su Solco.';
/** Titolo quando il brano non si può leggere (indice lento, link non valido). */
export const FEATURED_SHARE_GENERIC_TITLE = 'Un brano in evidenza su Solco';

/** True per un id di condivisione ben formato (solo la forma: l'esistenza la dice il server). */
export function isFeaturedShareId(value: unknown): value is string {
  return typeof value === 'string' && FEATURED_SHARE_ID_PATTERN.test(value);
}

/** Percorso della pagina pubblica del brano: /evidenza/<id>. */
export function featuredSharePath(shareId: string): string {
  return `${FEATURED_SHARE_PAGE_PREFIX}${encodeURIComponent(shareId)}`;
}

/**
 * Scheda di anteprima social (JPEG 1200×630): un solo indirizzo, senza query string; l'estensione
 * .jpg la fa trattare come un file statico dai crawler dei link.
 */
export function featuredShareImagePath(shareId: string): string {
  return `${featuredSharePath(shareId)}/anteprima.jpg`;
}

/** Percorso dell'API del brano condiviso. */
export function featuredShareApiPath(shareId: string): string {
  return `${FEATURED_SHARE_API_PREFIX}${encodeURIComponent(shareId)}`;
}

/** Copertina quadrata del brano condiviso, servita per id (mai il pathname nello store). */
export function featuredShareCoverPath(shareId: string): string {
  return `${featuredShareApiPath(shareId)}/cover`;
}

/** True per il percorso della copertina di un id valido (contratto dell'API). */
export function isFeaturedShareCoverPath(value: string): boolean {
  if (!value.startsWith(FEATURED_SHARE_API_PREFIX) || !value.endsWith('/cover')) return false;
  return isFeaturedShareId(value.slice(FEATURED_SHARE_API_PREFIX.length, -'/cover'.length));
}

/** Titolo pronto per anteprime e testi: compatto, senza nulla che sembri un indirizzo web. */
export function featuredShareTitle(title: string): string {
  return shareCardText(title, 'title') || 'Brano in evidenza';
}

/** Artista pronto per anteprime e testi (null se manca o resta vuoto dopo la pulizia). */
export function featuredShareArtist(artist: string | null | undefined): string | null {
  return artist ? shareCardText(artist, 'artist') || null : null;
}

/** og:title della pagina: «Titolo · Artista» (solo il titolo senza artista). */
export function featuredShareLabel(title: string, artist: string | null | undefined): string {
  const cleanTitle = featuredShareTitle(title);
  const cleanArtist = featuredShareArtist(artist);
  return cleanArtist ? `${cleanTitle} · ${cleanArtist}` : cleanTitle;
}

/** Testo della condivisione: «Ascolta «Titolo» di Artista su Solco.» (mai indirizzi web). */
export function featuredShareText(title: string, artist: string | null | undefined): string {
  const cleanArtist = featuredShareArtist(artist);
  const by = cleanArtist ? ` di ${cleanArtist}` : '';
  return `Ascolta «${featuredShareTitle(title)}»${by} su Solco.`;
}
