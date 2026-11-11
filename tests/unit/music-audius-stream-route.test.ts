// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configured: true,
  check: vi.fn(),
  streamTrack: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/music/audius-playback.server', () => ({
  createAudiusPlaybackService: () => ({
    configured: mocks.configured,
    check: mocks.check,
    streamTrack: mocks.streamTrack,
  }),
  playbackFailureStatus: (reason: string) =>
    reason === 'rate_limited'
      ? 429
      : ['gated', 'access_denied', 'not_streamable'].includes(reason)
        ? 403
        : 503,
}));

import { GET } from '@/app/api/music/audius/tracks/[trackId]/stream/route';

const requestFor = (range?: string) =>
  GET(
    new Request('https://solco.test/api/music/audius/tracks/track-71/stream', {
      headers: range ? { range } : undefined,
    }),
    { params: Promise.resolve({ trackId: 'track-71' }) },
  );

describe('stream Audius pubblico', () => {
  beforeEach(() => {
    mocks.configured = true;
    mocks.check.mockReset().mockResolvedValue({ allowed: true });
    mocks.streamTrack.mockReset().mockResolvedValue(
      new Response(Uint8Array.from([1, 2]), {
        status: 206,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': '2',
          'content-range': 'bytes 0-1/10',
        },
      }),
    );
  });

  it('inoltra solo byte audio dopo una nuova conferma Audius e rispetta Range', async () => {
    const response = await requestFor('bytes=0-1');

    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('content-range')).toBe('bytes 0-1/10');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2]);
    expect(mocks.check).toHaveBeenCalledWith('track-71');
    expect(mocks.streamTrack).toHaveBeenCalledWith('track-71', 'bytes=0-1');
  });

  it('non richiede byte quando Audius non autorizza la riproduzione', async () => {
    mocks.check.mockResolvedValueOnce({ allowed: false, reason: 'gated' });
    const response = await requestFor();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'gated' });
    expect(response.headers.get('accept-ranges')).toBeNull();
    expect(mocks.streamTrack).not.toHaveBeenCalled();
  });

  it('scarta una risposta upstream che non è audio', async () => {
    mocks.streamTrack.mockResolvedValueOnce(
      new Response('not audio', { headers: { 'content-type': 'text/html' } }),
    );
    const response = await requestFor();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'stream_unavailable' });
  });
});
