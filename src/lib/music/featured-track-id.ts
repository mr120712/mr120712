// @polsia:user-owned — l'id nel player di un "brano in evidenza" (file audio dello store Vercel Blob
// mostrato in Home): `upload:<pathname>`, per esempio `upload:Pop/Autrice - Canzone.mp3`. È lo stesso
// prefisso degli upload degli utenti della libreria pubblica (oggi spenta), che però hanno un id
// cuid senza estensione: un brano in evidenza si riconosce dal pathname, con le stesse regole del
// server (home-tracks.server: cartelle sicure, estensione audio, mai `public-uploads/`).
// Logica PURA (client, server e test): il server rivalida comunque il pathname sullo store.

export const FEATURED_QUALIFIED_PREFIX = 'upload:';
/** Prefisso dello store riservato agli upload degli utenti: mai un brano in evidenza. */
const USER_UPLOAD_PREFIX = 'public-uploads/';
/** Estensioni audio riconosciute, le stesse di home-tracks.server (list() non dà il content-type). */
const FEATURED_AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'm4b',
  'aac',
  'ogg',
  'oga',
  'opus',
  'wav',
  'flac',
  'webm',
  'weba',
]);

/** Pathname plausibile di un brano in evidenza (il server lo rivalida comunque sullo store). */
export function isFeaturedPathname(pathname: string): boolean {
  if (!pathname || pathname.length > 1024 || pathname.startsWith('/')) return false;
  if (pathname.includes('\\') || pathname.startsWith(USER_UPLOAD_PREFIX)) return false;
  for (let index = 0; index < pathname.length; index += 1) {
    const code = pathname.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  const segments = pathname.split('/');
  if (!segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')) {
    return false;
  }
  // Come fileExtension del server: un nome che inizia col punto (".mp3") non ha estensione.
  const base = segments[segments.length - 1] ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && FEATURED_AUDIO_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** L'id del player di un brano in evidenza dal suo pathname nello store. */
export function featuredQualifiedId(pathname: string): string {
  return `${FEATURED_QUALIFIED_PREFIX}${pathname}`;
}

/** Il pathname di un brano in evidenza dal suo id, o null se l'id non è di un brano in evidenza. */
export function featuredPathnameFromQualifiedId(qualifiedId: string): string | null {
  if (!qualifiedId.startsWith(FEATURED_QUALIFIED_PREFIX)) return null;
  const pathname = qualifiedId.slice(FEATURED_QUALIFIED_PREFIX.length);
  return isFeaturedPathname(pathname) ? pathname : null;
}

/** True per l'id di un brano in evidenza (non un upload utente, non l'id storico di audio.com). */
export function isFeaturedPlayId(qualifiedId: string): boolean {
  return featuredPathnameFromQualifiedId(qualifiedId) !== null;
}
