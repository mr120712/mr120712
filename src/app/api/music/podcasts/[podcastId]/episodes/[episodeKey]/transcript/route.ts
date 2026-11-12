// @polsia:user-owned — GET trascritto di un episodio podcast (tag podcast:transcript del feed).
// Il trascritto è un servizio dell'editore del podcast (Podcasting 2.0): l'URL è risolto dal feed
// ufficiale dello show (mai scelto dall'utente), scaricato SSRF-safe con un tetto di byte, e
// convertito in segmenti (con i tempi, dove il formato li ha, per sincronizzare con l'ascolto).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { PodcastTranscriptResponseSchema } from '@/lib/contracts/library';
import { parseTranscript } from '@/lib/music/podcast-transcript';
import { getPodcastDetail } from '@/lib/music/podcasts.server';
import { ssrfSafeFetch } from '@/lib/net/ssrf-safe-fetch.server';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 3 * 1024 * 1024;
const privateHeaders = { 'Cache-Control': 'private, no-store' };

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } catch {
    return null;
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(buffer);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ podcastId: string; episodeKey: string }> },
) {
  const { podcastId, episodeKey } = await params;
  if (!/^[0-9]{1,20}$/.test(podcastId) || !/^[A-Za-z0-9_-]{1,64}$/.test(episodeKey)) {
    return NextResponse.json(
      { error: 'episode_not_found' },
      { status: 404, headers: privateHeaders },
    );
  }

  const identity = getRateLimitIdentity(null, request.headers);
  if (identity) {
    const limited = await enforceRateLimit('music.catalog', identity);
    if (limited) {
      limited.headers.set('Cache-Control', 'private, no-store');
      return limited;
    }
  }

  const detail = await getPodcastDetail(podcastId);
  if (detail.outcome === 'unavailable') {
    return NextResponse.json(
      { error: 'podcast_unavailable' },
      { status: 502, headers: privateHeaders },
    );
  }
  const episode = detail.episodes.find((item) => item.key === episodeKey);
  if (!episode) {
    return NextResponse.json(
      { error: 'episode_not_found' },
      { status: 404, headers: privateHeaders },
    );
  }

  if (!episode.transcriptUrl) {
    return NextResponse.json(
      PodcastTranscriptResponseSchema.parse({ available: false, timed: false, cues: [] }),
      { headers: privateHeaders },
    );
  }

  let text: string | null = null;
  let contentType = episode.transcriptType ?? '';
  try {
    const response = await ssrfSafeFetch(episode.transcriptUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    const declared = Number(response.headers.get('content-length'));
    if (!response.ok || (Number.isFinite(declared) && declared > MAX_BYTES)) {
      throw new Error('bad transcript response');
    }
    contentType = response.headers.get('content-type') ?? contentType;
    text = await readBoundedText(response, MAX_BYTES);
  } catch {
    return NextResponse.json(
      { error: 'transcript_unavailable' },
      { status: 502, headers: privateHeaders },
    );
  }

  if (text === null) {
    return NextResponse.json(
      { error: 'transcript_unavailable' },
      { status: 502, headers: privateHeaders },
    );
  }

  const parsed = parseTranscript(text, contentType);
  return NextResponse.json(
    PodcastTranscriptResponseSchema.parse({
      available: parsed.cues.length > 0,
      timed: parsed.timed,
      cues: parsed.cues,
    }),
    { headers: privateHeaders },
  );
}
