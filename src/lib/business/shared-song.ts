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

/** Search for the same song in the listener's Spotify app (a plain link, no Spotify API). */
export function spotifySearchUrl(title: string, artist: string | null) {
  const query = `${artist ?? ''} ${title}`.replace(/\s+/g, ' ').trim();
  return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}

/**
 * Plain link to SoundCloud's own search page. Solco uses neither the SoundCloud API nor its
 * embedded player (their API terms exclude multi-source and paid services like Solco): the
 * listener simply continues on soundcloud.com.
 */
export function soundcloudSearchUrl(title: string, artist: string | null) {
  const query = `${artist ?? ''} ${title}`.replace(/\s+/g, ' ').trim();
  return `https://soundcloud.com/search/sounds?q=${encodeURIComponent(query)}`;
}

/** Deezer's own search page (plain link: no Deezer API, SDK or previews inside Solco). */
export function deezerSearchUrl(title: string, artist: string | null) {
  const query = `${artist ?? ''} ${title}`.replace(/\s+/g, ' ').trim();
  return `https://www.deezer.com/search/${encodeURIComponent(query)}`;
}

/** TIDAL's own search page (plain link: no TIDAL API or Player SDK inside Solco). */
export function tidalSearchUrl(title: string, artist: string | null) {
  const query = `${artist ?? ''} ${title}`.replace(/\s+/g, ' ').trim();
  return `https://tidal.com/search?q=${encodeURIComponent(query)}`;
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * YouTube Music: the same video when the track is a YouTube video, otherwise a search. Listeners
 * with a YouTube (Music) Premium subscription can keep listening there in the background.
 */
export function youtubeMusicUrl(title: string, artist: string | null, videoId?: string | null) {
  if (videoId && YOUTUBE_VIDEO_ID.test(videoId)) {
    return `https://music.youtube.com/watch?v=${videoId}`;
  }
  const query = `${artist ?? ''} ${title}`.replace(/\s+/g, ' ').trim();
  return `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
}

export type ListenElsewhereLink = { id: string; label: string; href: string };

/** The "Ascolta altrove" menu: plain links to the same song on other services. */
export function listenElsewhereLinks(input: {
  title: string;
  artist: string | null;
  youtubeVideoId?: string | null;
}): ListenElsewhereLink[] {
  const title = input.title.replace(/\s+/g, ' ').trim();
  if (!title) return [];
  const artist = input.artist?.replace(/\s+/g, ' ').trim() || null;
  return [
    { id: 'spotify', label: 'Apri in Spotify', href: spotifySearchUrl(title, artist) },
    {
      id: 'youtube-music',
      label: input.youtubeVideoId ? 'Apri in YouTube Music' : 'Cerca su YouTube Music',
      href: youtubeMusicUrl(title, artist, input.youtubeVideoId),
    },
    { id: 'soundcloud', label: 'Cerca su SoundCloud', href: soundcloudSearchUrl(title, artist) },
    { id: 'deezer', label: 'Cerca su Deezer', href: deezerSearchUrl(title, artist) },
    { id: 'tidal', label: 'Cerca su TIDAL', href: tidalSearchUrl(title, artist) },
  ];
}
