// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getPodcastDetail: vi.fn(),
  ssrfSafeFetch: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock('@/lib/music/podcasts.server', () => ({ getPodcastDetail: mocks.getPodcastDetail }));
vi.mock('@/lib/net/ssrf-safe-fetch.server', () => ({ ssrfSafeFetch: mocks.ssrfSafeFetch }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  // Nessun x-real-ip nei test → identità null → il rate-limit è saltato.
  getRateLimitIdentity: (userId: string | null) => (userId ? `user:${userId}` : null),
}));

import { GET } from '@/app/api/music/podcasts/[podcastId]/episodes/[episodeKey]/transcript/route';

function get() {
  return new Request('https://solco.example/api/music/podcasts/1/episodes/abc/transcript');
}
const params = Promise.resolve({ podcastId: '1', episodeKey: 'abc' });

function episode(over: Record<string, unknown> = {}) {
  return {
    key: 'abc',
    title: 'Ep',
    publishedAt: null,
    durationSeconds: null,
    description: null,
    artworkUrl: null,
    hasTranscript: true,
    audioUrl: 'https://cdn.example/ep.mp3',
    transcriptUrl: 'https://cdn.example/ep.vtt',
    transcriptType: 'text/vtt',
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('GET transcript', () => {
  it('404 per episodio inesistente', async () => {
    mocks.getPodcastDetail.mockResolvedValue({ outcome: 'results', podcast: {}, episodes: [] });
    const res = await GET(get(), { params });
    expect(res.status).toBe(404);
  });

  it('available:false quando l’episodio non ha trascritto', async () => {
    mocks.getPodcastDetail.mockResolvedValue({
      outcome: 'results',
      podcast: {},
      episodes: [episode({ hasTranscript: false, transcriptUrl: null, transcriptType: null })],
    });
    const res = await GET(get(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, timed: false, cues: [] });
    expect(mocks.ssrfSafeFetch).not.toHaveBeenCalled();
  });

  it('scarica e analizza il trascritto VTT', async () => {
    mocks.getPodcastDetail.mockResolvedValue({
      outcome: 'results',
      podcast: {},
      episodes: [episode()],
    });
    mocks.ssrfSafeFetch.mockResolvedValue(
      new Response('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nCiao a tutti', {
        headers: { 'content-type': 'text/vtt' },
      }),
    );
    const res = await GET(get(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: true,
      timed: true,
      cues: [{ startSeconds: 1, text: 'Ciao a tutti' }],
    });
    expect(mocks.ssrfSafeFetch).toHaveBeenCalledWith(
      'https://cdn.example/ep.vtt',
      expect.anything(),
    );
  });

  it('502 se lo scaricamento del trascritto fallisce', async () => {
    mocks.getPodcastDetail.mockResolvedValue({
      outcome: 'results',
      podcast: {},
      episodes: [episode()],
    });
    mocks.ssrfSafeFetch.mockResolvedValue(new Response('', { status: 403 }));
    const res = await GET(get(), { params });
    expect(res.status).toBe(502);
  });
});
