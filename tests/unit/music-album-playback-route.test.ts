// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requirePro: vi.fn(), catalogCheck: vi.fn(), resolve: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/solco-pro-entitlement', () => ({ requireSolcoPro: mocks.requirePro }));
vi.mock('@/lib/music/current-catalog-track.server', () => ({
  checkCurrentAudiusTrack: mocks.catalogCheck,
}));
vi.mock('@/lib/music/streaming-rights.server', () => ({
  resolveVerifiedTrackPlayback: mocks.resolve,
}));

import { GET } from '@/app/api/music/albums/[albumId]/tracks/[trackId]/playback/route';

const params = { params: Promise.resolve({ albumId: 'album-71', trackId: 'track-71' }) };
const pro = { allowed: true, user: { id: 'pro-user-1' }, entitlement: { id: 'ent-1' } };
const verified = {
  state: 'verified',
  albumId: 'album-71',
  trackId: 'track-71',
  source: {
    sourceId: 'source-1', albumId: 'album-71', trackId: 'track-71', completeness: 'full_track',
    durationSeconds: 180, mimeType: 'audio/mp4', byteLength: 2000,
  },
  rights: {
    evidenceId: 'evidence-1', albumId: 'album-71', trackId: 'track-71', grant: 'solco_streaming',
    sourceId: 'source-1', durationSeconds: 180,
    validFrom: '2026-11-01T00:00:00.000Z', validUntil: '2027-11-01T00:00:00.000Z',
  },
  checkSourceAvailable: vi.fn(async () => true),
  checkRightsEvidenceAvailable: vi.fn(async () => true),
  openStream: vi.fn(async () => new Response()),
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requirePro.mockResolvedValue(pro);
  mocks.catalogCheck.mockResolvedValue({ state: 'current' });
  mocks.resolve.mockResolvedValue(verified);
});

describe('preflight dell’ascolto integrale', () => {
  it.each([
    ['sessione anonima', 401, 'unauthorized'],
    ['account non Pro o entitlement scaduto', 403, 'pro_required'],
    ['verifica dell’entitlement indisponibile', 503, 'entitlement_unavailable'],
  ])('nega prima delle letture di catalogo o diritti per %s', async (_name, status, error) => {
    mocks.requirePro.mockResolvedValueOnce({
      allowed: false,
      response: Response.json({ error }, { status }),
    });
    const response = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/playback'),
      params,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ allowed: false, reason: error });
    expect(mocks.catalogCheck).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('consente il preflight solo per la coppia album e brano Audius corrente con diritti verificati', async () => {
    const response = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/playback'),
      params,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ allowed: true });
    expect(mocks.catalogCheck).toHaveBeenCalledWith('album-71', 'track-71');
    expect(mocks.resolve).toHaveBeenCalledWith('album-71', 'track-71');
  });

  it('nega se catalogo o prova non sono verificabili', async () => {
    mocks.catalogCheck.mockResolvedValueOnce({ state: 'unavailable' });
    const catalog = await GET(new Request('https://solco.test/playback'), params);
    expect(catalog.status).toBe(503);
    expect(await catalog.json()).toEqual({ allowed: false, reason: 'catalog_unavailable' });
    expect(mocks.resolve).not.toHaveBeenCalled();

    mocks.resolve.mockResolvedValueOnce({ state: 'unavailable', reason: 'rights_unverified' });
    const rights = await GET(new Request('https://solco.test/playback'), params);
    expect(rights.status).toBe(403);
    expect(await rights.json()).toEqual({ allowed: false, reason: 'rights_unverified' });
  });
});
