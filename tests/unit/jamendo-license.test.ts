// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumePlay: vi.fn(async () => ({ allowed: true, counted: true, used: 1, limit: 40 })),
  rateLimit: vi.fn(async () => null),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/play-quota.server', () => ({
  consumePlayForCurrentUser: mocks.consumePlay,
  playDeniedResponse: vi.fn(),
}));
// The stream route checks the quota and records plays through stream-play.server.
vi.mock('@/lib/music/stream-play.server', () => ({
  checkStreamPlay: mocks.consumePlay,
  recordStreamPlay: mocks.consumePlay,
  willCountStreamPlay: () => false,
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.rateLimit,
  getRateLimitIdentity: () => 'ip:192.0.2.71',
}));

import { GET as playback } from '@/app/api/music/jamendo/[trackId]/playback/route';
import { GET as stream } from '@/app/api/music/jamendo/[trackId]/stream/route';
import { GET as catalog } from '@/app/api/music/jamendo/route';
import {
  clearJamendoCache,
  listJamendoTracks,
  resolveJamendoAudio,
} from '@/lib/music/jamendo.server';
import { jamendoEnabled } from '@/lib/music/jamendo-license';

const params = { params: Promise.resolve({ trackId: '1532771' }) };
const request = (path: string) => new Request(`https://solco.test${path}`);

beforeEach(() => {
  clearJamendoCache();
  mocks.consumePlay.mockClear();
  mocks.rateLimit.mockClear();
  // A client id alone is not enough: the commercial licence is missing.
  vi.stubEnv('JAMENDO_CLIENT_ID', 'jamendo-id');
  vi.stubEnv('JAMENDO_COMMERCIAL_LICENSE', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('Jamendo spento finché manca una licenza commerciale', () => {
  it('si accende solo con client id e JAMENDO_COMMERCIAL_LICENSE=confirmed', () => {
    expect(jamendoEnabled({})).toBe(false);
    expect(jamendoEnabled({ JAMENDO_CLIENT_ID: 'id' })).toBe(false);
    expect(jamendoEnabled({ JAMENDO_CLIENT_ID: 'id', JAMENDO_COMMERCIAL_LICENSE: 'yes' })).toBe(
      false,
    );
    expect(jamendoEnabled({ JAMENDO_COMMERCIAL_LICENSE: 'confirmed' })).toBe(false);
    expect(
      jamendoEnabled({ JAMENDO_CLIENT_ID: ' ', JAMENDO_COMMERCIAL_LICENSE: 'confirmed' }),
    ).toBe(false);
    expect(
      jamendoEnabled({ JAMENDO_CLIENT_ID: 'id', JAMENDO_COMMERCIAL_LICENSE: 'confirmed' }),
    ).toBe(true);
  });

  it('il catalogo risponde "not_configured" senza chiamare Jamendo', async () => {
    const fetcher = vi.fn();
    expect(await listJamendoTracks({ q: 'jazz' }, fetcher as unknown as typeof fetch)).toEqual({
      outcome: 'not_configured',
      tracks: [],
    });
    expect(await resolveJamendoAudio('1532771', fetcher as unknown as typeof fetch)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('l\'API del catalogo risponde "not_configured" prima del limite di richieste', async () => {
    const response = await catalog(request('/api/music/jamendo?q=jazz'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'not_configured', tracks: [] });
    // A 429 from the shared catalogue bucket must never make the section appear.
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it('verifica e stream rispondono "not_configured" e non consumano ascolti Free', async () => {
    const check = await playback(request('/api/music/jamendo/1532771/playback'), params);
    expect(check.status).toBe(503);
    expect(await check.json()).toEqual({
      allowed: false,
      reason: 'track_unavailable',
      error: 'not_configured',
    });

    const audio = await stream(request('/api/music/jamendo/1532771/stream'), params);
    expect(audio.status).toBe(503);
    expect(await audio.json()).toEqual({ error: 'not_configured' });
    expect(mocks.consumePlay).not.toHaveBeenCalled();
  });

  it('con la licenza confermata la verifica torna disponibile', async () => {
    vi.stubEnv('JAMENDO_COMMERCIAL_LICENSE', 'confirmed');
    const check = await playback(request('/api/music/jamendo/1532771/playback'), params);
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ allowed: true });
  });
});
