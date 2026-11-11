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

import { GET } from '@/app/api/music/audius/tracks/[trackId]/playback/route';

const requestFor = (trackId: string) =>
  GET(new Request(`https://solco.test/api/music/audius/tracks/${trackId}/playback`), {
    params: Promise.resolve({ trackId }),
  });

describe('preflight playback Audius pubblico', () => {
  beforeEach(() => {
    mocks.configured = true;
    mocks.check.mockReset().mockResolvedValue({ allowed: true });
    mocks.streamTrack.mockReset();
  });

  it('autorizza il player quando Audius conferma che il brano è riproducibile', async () => {
    const response = await requestFor('track-71');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ allowed: true });
    expect(mocks.check).toHaveBeenCalledWith('track-71');
  });

  it('nega il preflight quando Audius nega lo stream, senza chiedere byte audio', async () => {
    mocks.check.mockResolvedValueOnce({ allowed: false, reason: 'not_streamable' });
    const response = await requestFor('track-71');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ allowed: false, reason: 'not_streamable' });
    expect(mocks.streamTrack).not.toHaveBeenCalled();
  });

  it('mostra una fonte non configurata senza rivelare la chiave server-side', async () => {
    mocks.configured = false;
    const response = await requestFor('track-71');
    const payload = await response.text();

    expect(response.status).toBe(503);
    expect(payload).toContain('source_inactive');
    expect(payload).not.toContain('API_KEY');
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('rifiuta identificativi non validi prima di interrogare Audius', async () => {
    const response = await requestFor('../track-71');

    expect(response.status).toBe(404);
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
