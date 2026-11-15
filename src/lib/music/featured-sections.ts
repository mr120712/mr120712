// @polsia:user-owned — «Mostra tutti» delle sezioni dei "brani in evidenza" (logica pura, client,
// server e test): forma dell'id opaco di una sezione (una cartella dello store, la radice è
// "In evidenza"), percorsi della pagina /cartella/<id> e della sua API, tetto ai brani elencati.
// L'id lo calcola SOLO il server (featured-sections.server: SHA-256 della cartella), quindi l'URL
// non contiene mai il percorso dello store; la pagina elenca SOLO i brani dichiarati in
// diritti.json, e una cartella senza brani dichiarati non ha link (404).
//
// Perché /cartella/<id> e non /evidenza/sezione/<id>: /evidenza/ è un prefisso PUBBLICO (link
// diretti dei singoli brani, visibili senza account in RequireLogin), mentre questa pagina sta
// dietro il login come la pagina d'artista. Un prefisso tutto suo non si scontra con
// /evidenza/<shareId> e non eredita per sbaglio le regole pubbliche di quel percorso.

/** Lunghezza dell'id: 22 caratteri base64url (132 bit dell'hash). */
export const FEATURED_SECTION_ID_LENGTH = 22;
/** Forma di un id di sezione valido: 22 caratteri [A-Za-z0-9_-]. */
export const FEATURED_SECTION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Prefisso della pagina «Mostra tutti» di una sezione. */
export const FEATURED_SECTION_PAGE_PREFIX = '/cartella/';
/** Prefisso dell'API della pagina di una sezione. */
export const FEATURED_SECTION_API_PREFIX = '/api/music/featured/sections/';
/** Tetto ai brani dichiarati di una sezione elencati nella sua pagina (dal più recente). */
export const FEATURED_SECTION_TRACK_LIMIT = 500;
/**
 * Titolo della sezione della RADICE dello store: in Home la sua intestazione è «Ascolta ora» (sotto
 * «In evidenza»), e la sua pagina mostra lo stesso titolo, così il link e la pagina coincidono.
 */
export const FEATURED_ROOT_SECTION_HEADING = 'Ascolta ora';

/** True per un id di sezione ben formato (solo la forma: l'esistenza la dice il server). */
export function isFeaturedSectionId(value: unknown): value is string {
  return typeof value === 'string' && FEATURED_SECTION_ID_PATTERN.test(value);
}

/** Percorso della pagina «Mostra tutti» di una sezione: /cartella/<id>. */
export function featuredSectionPath(sectionId: string): string {
  return `${FEATURED_SECTION_PAGE_PREFIX}${encodeURIComponent(sectionId)}`;
}

/** Percorso dell'API della sezione. */
export function featuredSectionApiPath(sectionId: string): string {
  return `${FEATURED_SECTION_API_PREFIX}${encodeURIComponent(sectionId)}`;
}
