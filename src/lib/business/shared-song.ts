// @polsia:user-owned — "Ascolta in Solco": riconosce titolo e artista dal testo che l'utente
// copia da un'altra app (Spotify, Apple Music, YouTube Music…) o scrive come "Artista - Titolo".
// Nessuna chiamata ad API di terzi: si legge solo il testo portato dall'utente.

export type SharedSong = { title: string; artist: string | null };

const URL_PATTERN = /https?:\/\/\S+/gi;
const QUOTES = /^["'«»“”‘’]+|["'«»“”‘’]+$/g;

function clean(value: string) {
  return value.replace(/\s+/g, ' ').replace(QUOTES, '').trim().slice(0, 200);
}

/** True when the text is only a link: a Spotify/Apple link carries no title to search for. */
export function isLinkOnly(text: string) {
  return (
    text.trim() !== '' &&
    text
      .replace(URL_PATTERN, '')
      .trim()
      .replace(/[:\-–—]/g, '') === ''
  );
}

/**
 * Title and artist from shared text, or null. Examples:
 * "Ascolta Titolo di Artista su Spotify: https://…", "Listen to Title by Artist on Spotify",
 * "Titolo by Artista", "Artista - Titolo".
 */
export function parseSharedSong(input: string): SharedSong | null {
  const text = input.replace(URL_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // "Ascolta X di Y su Spotify" / "Listen to X by Y on Apple Music" (the service name is optional).
  const shared =
    /^(?:ascolta|listen to|check out|guarda)\s+(.+?)\s+(?:di|by|de|von)\s+(.+?)(?:\s+(?:su|on|en|auf)\s+[A-Z][\w .]*?)?[\s:.,!]*$/i.exec(
      text,
    );
  if (shared?.[1] && shared[2]) {
    return { title: clean(shared[1]), artist: clean(shared[2]) || null };
  }

  // "Title by Artist" (English share text without the leading verb).
  const by = /^(.+?)\s+by\s+(.+?)(?:\s+on\s+[A-Z][\w .]*?)?[\s:.,!]*$/i.exec(text);
  if (by?.[1] && by[2]) return { title: clean(by[1]), artist: clean(by[2]) || null };

  // "Artist - Title" (Solco's own convention, also used by the track-list import).
  const parts = text.split(/\s+[-–—]\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return { artist: clean(parts[0]) || null, title: clean(parts.slice(1).join(' - ')) };
  }

  const title = clean(text.replace(/[\s:.,!]*$/, ''));
  return title ? { title, artist: null } : null;
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * YouTube (app/sito) sul video esatto, per chi possiede YouTube Premium: lì l'abbonamento vale
 * (niente pubblicità, ascolto in background). Solo con un id valido, altrimenti null: niente ricerca
 * di ripiego, così il tasto «Premium» apre sempre il brano giusto o non compare. È solo un link:
 * nessuna API, e Solco non può usare il Premium dentro il proprio player.
 */
export function youtubeWatchUrl(videoId: string | null | undefined): string | null {
  if (videoId && YOUTUBE_VIDEO_ID.test(videoId)) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return null;
}
