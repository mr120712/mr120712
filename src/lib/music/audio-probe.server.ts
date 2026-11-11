// @polsia:user-owned — prima di contare un ascolto reindirizzato (podcast, Jamendo, radio)
// verifica che il file o lo stream ufficiale risponda davvero con audio.
import 'server-only';
import { assertPublicHttpsUrl } from '@/lib/music/podcasts.server';

type FetchLike = typeof fetch;

const PROBE_TIMEOUT_MS = 8_000;
// Browsers follow up to 20; podcast analytics chains (op3, podtrac, chrt, megaphone…) use 4-6.
const MAX_REDIRECTS = 10;
const USER_AGENT = 'Solco/1.0 (audio check)';
// Playlists answer with an audio/* type but carry no audio: <audio> cannot play them.
const PLAYLIST_TYPES = new Set([
  'audio/x-mpegurl',
  'audio/mpegurl',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'audio/x-scpls',
  'audio/scpls',
]);

/**
 * False only for a type that is clearly not audio: text and HTML pages, JSON/XML documents,
 * images, scripts and playlists. Anything else may be audio, as the browser would try it:
 * `application/octet-stream` / `binary/octet-stream` (the S3 default for self-hosted podcast
 * files) or a missing type. The feed already declares the enclosure as audio/*.
 */
export function mayBeAudioContentType(value: string | null) {
  const type = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (!type) return true;
  if (PLAYLIST_TYPES.has(type)) return false;
  if (type.startsWith('text/') || type.startsWith('image/')) return false;
  if (type.endsWith('/json') || type.endsWith('+json')) return false;
  if (type.endsWith('/xml') || type.endsWith('+xml') || type.endsWith('/html')) return false;
  return !type.endsWith('/javascript');
}

function discard(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Opens the URL server-side and closes it as soon as the headers arrive: true only for a
 * 200/206 response with a body whose type may be audio. Every hop (redirects included) must be
 * public HTTPS (SSRF guard shared with the podcast feeds); a plain-HTTP hop is upgraded to HTTPS,
 * as browsers do for media. Files are asked for their first 2 bytes; a live stream (`live`) is
 * opened without Range. No byte reaches the listener from here.
 */
export async function probeAudioUrl(
  url: string,
  options: {
    live?: boolean;
    fetcher?: FetchLike;
    resolve?: (host: string) => Promise<string[]>;
  } = {},
): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  const headers: Record<string, string> = { Accept: 'audio/*', 'User-Agent': USER_AGENT };
  if (!options.live) headers.Range = 'bytes=0-1';
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      const target = await assertPublicHttpsUrl(current, options.resolve);
      response = await fetcher(target, {
        method: 'GET',
        headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        discard(response);
        if (!location) return false;
        const next = new URL(location, target);
        // Mixed-content upgrade, as in the browser; the SSRF guard checks the upgraded URL.
        if (next.protocol === 'http:') next.protocol = 'https:';
        current = next.toString();
        continue;
      }
    } catch {
      return false;
    }
    const ok =
      (response.status === 200 || response.status === 206) &&
      response.body !== null &&
      mayBeAudioContentType(response.headers.get('content-type'));
    discard(response);
    return ok;
  }
  return false;
}
