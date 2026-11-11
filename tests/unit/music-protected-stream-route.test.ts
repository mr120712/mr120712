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

import { GET } from '@/app/api/music/albums/[albumId]/tracks/[trackId]/stream/route';

const params = { params: Promise.resolve({ albumId: 'album-71', trackId: 'track-71' }) };
const activePro = { allowed: true, user: { id: 'pro-user-1' }, entitlement: { id: 'ent-1' } };

function verified(
  openStream = vi.fn(async (range: string | null) => {
  if (range) {
    return new Response(new Uint8Array([2, 3, 4]), {
      status: 206,
      headers: {
        'content-type': 'audio/mp4',
        'content-length': '3',
        'content-range': 'bytes 2-4/10',
      },
    });
  }
  return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), {
    status: 200,
    headers: { 'content-type': 'audio/mp4', 'content-length': '10' },
  });
  }),
  checkSourceAvailable = vi.fn(async () => true),
) {
  return {
    state: 'verified',
    albumId: 'album-71',
    trackId: 'track-71',
    source: {
      sourceId: 'private-source-id',
      albumId: 'album-71',
      trackId: 'track-71',
      completeness: 'full_track',
      durationSeconds: 183,
      mimeType: 'audio/mp4',
      byteLength: 10,
    },
    rights: {
      evidenceId: 'private-evidence-id',
      albumId: 'album-71',
      trackId: 'track-71',
      grant: 'solco_streaming',
      sourceId: 'private-source-id',
      durationSeconds: 183,
      validFrom: '2026-11-01T00:00:00.000Z',
      validUntil: '2027-11-01T00:00:00.000Z',
    },
    checkSourceAvailable,
    checkRightsEvidenceAvailable: vi.fn(async () => true),
    openStream,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requirePro.mockResolvedValue(activePro);
  mocks.catalogCheck.mockResolvedValue({ state: 'current' });
  mocks.resolve.mockResolvedValue(verified());
});

describe('stream privato per brani Solco Pro', () => {
  it.each([
    ['anonimo', 401, { error: 'unauthorized' }],
    ['non Pro o entitlement scaduto', 403, { error: 'pro_required' }],
    ['entitlement non verificabile', 503, { error: 'entitlement_unavailable' }],
  ])('nega lo stream a un utente %s anche su byte-range, senza leggere diritti o storage', async (_label, status, body) => {
    mocks.requirePro.mockResolvedValueOnce({
      allowed: false,
      response: Response.json(body, { status }),
    });
    const response = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream', {
        headers: { range: 'bytes=0-1' },
      }),
      params,
    );
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject(body);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.catalogCheck).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('nega se album o brano non sono nel catalogo Audius corrente', async () => {
    mocks.catalogCheck.mockResolvedValueOnce({ state: 'not_found' });
    const missing = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream'),
      params,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'track_unavailable' });
    expect(mocks.resolve).not.toHaveBeenCalled();

    mocks.catalogCheck.mockResolvedValueOnce({ state: 'unavailable' });
    const unavailable = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream'),
      params,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'catalog_unavailable' });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('nega senza byte quando fonte o prova non sono correnti', async () => {
    mocks.resolve.mockResolvedValueOnce({
      state: 'unavailable',
      albumId: 'album-71',
      trackId: 'track-71',
      reason: 'rights_unverified',
    });
    const response = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream'),
      params,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'rights_unverified' });
    expect(mocks.requirePro).toHaveBeenCalledOnce();
    expect(mocks.catalogCheck).toHaveBeenCalledWith('album-71', 'track-71');
  });

  it('inoltra solo la sorgente verificata e non espone chiavi o URL privati', async () => {
    const response = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream'),
      params,
    );
    const body = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect([...body]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(response.headers.get('content-type')).toBe('audio/mp4');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(JSON.stringify(Object.fromEntries(response.headers))).not.toMatch(/signed|fileKey|sourceId/i);
    expect(mocks.catalogCheck).toHaveBeenCalledWith('album-71', 'track-71');
  });

  it('ricontrolla Pro prima di una richiesta byte-range successiva', async () => {
    mocks.requirePro
      .mockResolvedValueOnce(activePro)
      .mockResolvedValueOnce({
        allowed: false,
        response: Response.json({ error: 'pro_required' }, { status: 403 }),
      });
    const full = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream'),
      params,
    );
    expect(full.status).toBe(200);
    await full.arrayBuffer();
    const range = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream', {
        headers: { range: 'bytes=2-4' },
      }),
      params,
    );
    expect(range.status).toBe(403);
    expect(range.headers.get('content-type')).toContain('application/json');
    expect(await range.json()).toEqual({ error: 'pro_required' });
    expect(mocks.requirePro).toHaveBeenCalledTimes(2);
    expect(mocks.catalogCheck).toHaveBeenCalledOnce();
    expect(mocks.resolve).toHaveBeenCalledOnce();
  });

  it('supporta byte-range solo su risposta parziale coerente con la fonte registrata', async () => {
    const openStream = vi.fn(async (range: string | null) => {
      expect(range).toBe('bytes=2-4');
      return new Response(new Uint8Array([2, 3, 4]), {
        status: 206,
        headers: {
          'content-type': 'audio/mp4',
          'content-length': '3',
          'content-range': 'bytes 2-4/10',
        },
      });
    });
    mocks.resolve.mockResolvedValueOnce(verified(openStream));
    const response = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream', {
        headers: { range: 'bytes=2-4' },
      }),
      params,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-4/10');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3, 4]);
  });

  it('nega senza aprire il brano quando il file privato registrato non è verificabile', async () => {
    const openStream = vi.fn();
    mocks.resolve.mockResolvedValueOnce(verified(openStream, vi.fn(async () => false)));
    const response = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream'),
      params,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'stream_unavailable' });
    expect(openStream).not.toHaveBeenCalled();
  });

  it('chiude senza audio se lo storage non è disponibile o i byte non corrispondono alla fonte', async () => {
    mocks.resolve.mockResolvedValueOnce(verified(vi.fn(async () => {
      throw new Error('private storage unavailable');
    })));
    const storageFailure = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream'),
      params,
    );
    expect(storageFailure.status).toBe(502);
    expect(storageFailure.headers.get('content-type')).toContain('application/json');
    expect(await storageFailure.json()).toEqual({ error: 'stream_unavailable' });

    mocks.resolve.mockResolvedValueOnce(verified(vi.fn(async () => new Response(new Uint8Array([9]), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': '10' },
    }))));
    const invalidSource = await GET(
      new Request('https://solco.test/api/music/albums/album-71/tracks/track-71/stream'),
      params,
    );
    expect(invalidSource.status).toBe(502);
    expect(invalidSource.headers.get('content-type')).toContain('application/json');
    expect(await invalidSource.json()).toEqual({ error: 'stream_unavailable' });
  });
});
