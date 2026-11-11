// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
  check: vi.fn(),
  streamTrack: vi.fn(),
  consumePlay: vi.fn(),
  getDetails: vi.fn(),
  searchPodcasts: vi.fn(),
  topPodcasts: vi.fn(),
  listStations: vi.fn(),
  listJamendoTracks: vi.fn(),
  albumCatalog: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/rate-limit.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/business/rate-limit.server')>()),
  enforceRateLimit: mocks.enforceRateLimit,
}));
vi.mock('@/lib/music/audius-playback.server', () => ({
  createAudiusPlaybackService: () => ({
    configured: true,
    check: mocks.check,
    streamTrack: mocks.streamTrack,
  }),
  playbackFailureStatus: () => 503,
}));
vi.mock('@/lib/business/play-quota.server', () => ({
  consumePlayForCurrentUser: mocks.consumePlay,
  playDeniedResponse: () => Response.json({ allowed: false }, { status: 401 }),
}));
// Stream routes check the Free quota without writing, and record the play once audio starts.
vi.mock('@/lib/music/stream-play.server', () => ({
  checkStreamPlay: async (qualifiedId: string) => ({
    qualifiedId,
    user: null,
    decision: await mocks.consumePlay(qualifiedId),
  }),
  recordStreamPlay: mocks.consumePlay,
}));
vi.mock('@/lib/music/music-api.server', () => ({ readYouTubeApiKey: () => 'server-only-key' }));
vi.mock('@/lib/music/youtube-search.server', () => ({ getYouTubeVideoDetails: mocks.getDetails }));
vi.mock('@/lib/music/podcasts.server', () => ({
  searchPodcasts: mocks.searchPodcasts,
  topPodcasts: mocks.topPodcasts,
}));
vi.mock('@/lib/music/radio-browser.server', () => ({ listStations: mocks.listStations }));
vi.mock('@/lib/music/jamendo.server', () => ({ listJamendoTracks: mocks.listJamendoTracks }));
// Rate limit of the switched-on catalogue (switched off, it answers "not_configured" before the
// limit: covered in jamendo-license.test.ts).
vi.mock('@/lib/music/jamendo-license', () => ({ jamendoEnabled: () => true }));
vi.mock('@/lib/music/audius-source.server', () => ({
  getAudiusAlbumCatalogDetail: mocks.albumCatalog,
}));

import { GET as albumDetail } from '@/app/api/music/albums/[albumId]/route';
import { GET as audiusPlayback } from '@/app/api/music/audius/tracks/[trackId]/playback/route';
import { GET as audiusStream } from '@/app/api/music/audius/tracks/[trackId]/stream/route';
import { GET as jamendo } from '@/app/api/music/jamendo/route';
import { GET as podcasts } from '@/app/api/music/podcasts/route';
import { GET as radio } from '@/app/api/music/radio/route';
import { GET as youtubeVideo } from '@/app/api/music/youtube/videos/[videoId]/route';

const ip = '192.0.2.71';
const video = {
  provider: 'youtube',
  videoId: 'dQw4w9WgXcQ',
  title: 'Video ufficiale',
  channelTitle: 'Canale ufficiale',
  channelId: 'UCsample123',
  description: null,
  publishedAt: null,
  thumbnailUrl: null,
};

function request(path: string, headers: Record<string, string> = { 'x-real-ip': ip }) {
  return new Request(`https://solco.test${path}`, { headers });
}

function rateLimited() {
  return Response.json(
    { error: 'rate_limited', message: 'Hai raggiunto il limite.', retryAfterSeconds: 30 },
    { status: 429, headers: { 'Retry-After': '30', 'Cache-Control': 'private, no-store' } },
  );
}

const routes = {
  audiusPlayback: () =>
    audiusPlayback(request('/api/music/audius/tracks/track-71/playback'), {
      params: Promise.resolve({ trackId: 'track-71' }),
    }),
  audiusStream: () =>
    audiusStream(request('/api/music/audius/tracks/track-71/stream'), {
      params: Promise.resolve({ trackId: 'track-71' }),
    }),
  albumDetail: () =>
    albumDetail(request('/api/music/albums/album-71'), {
      params: Promise.resolve({ albumId: 'album-71' }),
    }),
  youtubeVideo: () =>
    youtubeVideo(request(`/api/music/youtube/videos/${video.videoId}`), {
      params: Promise.resolve({ videoId: video.videoId }),
    }),
  podcasts: () => podcasts(request('/api/music/podcasts?q=storia')),
  radio: () => radio(request('/api/music/radio?q=jazz')),
  jamendo: () => jamendo(request('/api/music/jamendo?q=lofi')),
};

const upstreams = {
  audiusPlayback: [mocks.check],
  audiusStream: [mocks.consumePlay, mocks.check, mocks.streamTrack],
  albumDetail: [mocks.albumCatalog],
  youtubeVideo: [mocks.getDetails],
  podcasts: [mocks.searchPodcasts, mocks.topPodcasts],
  radio: [mocks.listStations],
  jamendo: [mocks.listJamendoTracks],
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.check.mockResolvedValue({ allowed: true });
  mocks.consumePlay.mockResolvedValue({ allowed: false, reason: 'login_required' });
  mocks.getDetails.mockResolvedValue({ outcome: 'found', details: { video, madeForKids: false } });
  mocks.searchPodcasts.mockResolvedValue({ outcome: 'no_results', podcasts: [] });
  mocks.topPodcasts.mockResolvedValue({ outcome: 'no_results', podcasts: [] });
  mocks.listStations.mockResolvedValue({ outcome: 'no_results', stations: [] });
  mocks.listJamendoTracks.mockResolvedValue({ outcome: 'no_results', tracks: [] });
  mocks.albumCatalog.mockResolvedValue({ state: 'not_found', reason: 'album_not_found' });
});

describe('limite per IP sui proxy anonimi del catalogo', () => {
  for (const name of Object.keys(routes) as (keyof typeof routes)[]) {
    it(`${name}: conta la richiesta per IP e blocca prima della fonte esterna`, async () => {
      mocks.enforceRateLimit.mockResolvedValueOnce(rateLimited());
      const response = await routes[name]();

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('30');
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.catalog', `ip:${ip}`);
      for (const upstream of upstreams[name]) expect(upstream).not.toHaveBeenCalled();
    });
  }

  it('non blocca né scrive limiti senza un IP affidabile (sviluppo locale)', async () => {
    const response = await podcasts(
      request('/api/music/podcasts?q=storia', { 'cf-connecting-ip': '198.51.100.9' }),
    );

    expect(response.status).toBe(200);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.searchPodcasts).toHaveBeenCalledWith('storia');
  });

  it('lascia passare le richieste entro il limite', async () => {
    const response = await routes.audiusPlayback();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: true });
    expect(mocks.check).toHaveBeenCalledWith('track-71');
  });
});

describe('cache CDN dei dettagli video YouTube', () => {
  it('rende pubblici in CDN solo i dettagli confermati da YouTube', async () => {
    const playable = await routes.youtubeVideo();
    expect((await playable.json()).eligibility).toBe('playable');
    expect(playable.headers.get('cache-control')).toMatch(/^public, .*s-maxage=\d+/);

    mocks.getDetails.mockResolvedValueOnce({
      outcome: 'found',
      details: { video, madeForKids: true },
    });
    const kids = await routes.youtubeVideo();
    expect((await kids.json()).eligibility).toBe('made_for_kids');
    expect(kids.headers.get('cache-control')).toMatch(/^public, /);
  });

  it('non mette in cache errori, quota esaurita o audience non verificata', async () => {
    for (const result of [
      { outcome: 'quota_exceeded' },
      { outcome: 'api_error' },
      { outcome: 'not_found' },
      { outcome: 'found', details: { video, madeForKids: null } },
    ]) {
      mocks.getDetails.mockResolvedValueOnce(result);
      const response = await routes.youtubeVideo();
      expect(response.headers.get('cache-control')).toContain('private, no-store');
    }
  });
});
