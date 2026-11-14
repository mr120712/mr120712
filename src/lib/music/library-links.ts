// @polsia:user-owned — indirizzi della Libreria condivisi fra la ricerca e la Libreria: il link
// diretto a una raccolta (/library?playlist=<id>) apre la scheda Playlist e porta alla raccolta.
export const LIBRARY_PLAYLIST_PARAM = 'playlist';

/** Link diretto a una raccolta dell'ascoltatore (playlist o Preferiti) nella Libreria. */
export function libraryPlaylistPath(collectionId: string): string {
  return `/library?${LIBRARY_PLAYLIST_PARAM}=${encodeURIComponent(collectionId)}`;
}
