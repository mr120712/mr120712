// @polsia:user-owned — link TikTok: convalida e forma canonica (funzioni pure, testabili).
// Solo l'Embed Player ufficiale v1 (iframe): nessuno script TikTok nella pagina, nessuno scraping.

const VIDEO_URL =
  /^https:\/\/(?:www\.|m\.)?tiktok\.com\/@([A-Za-z0-9._]{2,24})\/video\/(\d{8,25})(?:[/?#].*)?$/;
const SOUND_URL = /^https:\/\/(?:www\.)?tiktok\.com\/music\/([^/?#]+-(\d{6,25}))(?:[?#].*)?$/;

export type TikTokVideoRef = { handle: string; videoId: string; canonicalUrl: string };

/** A full TikTok video link → handle, id (kept as a string: ~19 digits) and canonical URL. */
export function parseTikTokVideoUrl(input: string): TikTokVideoRef | null {
  const match = VIDEO_URL.exec(input.trim());
  if (!match?.[1] || !match[2]) return null;
  return {
    handle: match[1],
    videoId: match[2],
    canonicalUrl: `https://www.tiktok.com/@${match[1]}/video/${match[2]}`,
  };
}

/** A TikTok sound page link without tracking parameters, or null. */
export function parseTikTokSoundUrl(input: string): string | null {
  const match = SOUND_URL.exec(input.trim());
  return match?.[1] ? `https://www.tiktok.com/music/${match[1]}` : null;
}

/** Short share links cannot be resolved without fetching TikTok: ask for the full link. */
export function isTikTokShortLink(input: string) {
  return /^https:\/\/(?:vm|vt)\.tiktok\.com\/|^https:\/\/(?:www\.)?tiktok\.com\/t\//.test(
    input.trim(),
  );
}

/** Official Embed Player v1. Autoplay only when the listener has just asked for the video. */
export function tiktokPlayerUrl(videoId: string, autoplay: boolean) {
  const params = new URLSearchParams({
    music_info: '1',
    description: '1',
    rel: '0',
    autoplay: autoplay ? '1' : '0',
  });
  return `https://www.tiktok.com/player/v1/${encodeURIComponent(videoId)}?${params.toString()}`;
}

export const TIKTOK_ORIGIN = 'https://www.tiktok.com';
