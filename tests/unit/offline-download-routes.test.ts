// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  requireAuth: vi.fn(),
  readKey: vi.fn(() => 'test-key'),
  reserve: vi.fn(),
  release: vi.fn(),
  resolveAudius: vi.fn(),
  downloadAudius: vi.fn(),
  fetchBounded: vi.fn(),
  getPodcastDetail: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/music/audius-api.server', () => ({
  createAudiusApiClient: () => ({ getTrack: vi.fn(), streamTrack: vi.fn() }),
  readAudiusApiKey: mocks.readKey,
  AudiusApiError: class AudiusApiError extends Error {},
}));
vi.mock('@/lib/music/podcasts.server', () => ({ getPodcastDetail: mocks.getPodcastDetail }));
vi.mock('@/lib/music/offline-download.server', () => ({
  reserveDownloadLimits: mocks.reserve,
  releaseDownloadLimits: mocks.release,
  resolveAudiusDownload: mocks.resolveAudius,
  downloadAudiusAudio: mocks.downloadAudius,
  fetchBoundedAudio: mocks.fetchBounded,
  resolveDownloadMime: (ct: string | null) => (ct?.startsWith('audio/') ? ct : 'audio/mpeg'),
  offlineDownloadError: (error: string, message: string, status: number, retry?: number) =>
    Response.json(
      { error, message, ...(retry ? { retryAfterSeconds: retry } : {}) },
      { status, headers: retry ? { 'Retry-After': String(retry) } : undefined },
    ),
  offlineDownloadResponse: (bytes: Uint8Array, mimeType: string, meta: unknown) =>
    new Response(bytes, {
      status: 200,
      headers: {
        'content-type': mimeType,
        'x-solco-download': Buffer.from(JSON.stringify(meta)).toString('base64'),
      },
    }),
}));

import { POST as audiusDownload } from '@/app/api/music/audius/tracks/[trackId]/download/route';
import { POST as podcastDownload } from '@/app/api/music/podcasts/[podcastId]/episodes/[episodeKey]/download/route';

function rateLimited() {
  return Response.json(
    { error: 'rate_limited', message: 'limite', retryAfterSeconds: 30 },
    { status: 429, headers: { 'Retry-After': '30', 'Cache-Control': 'private, no-store' } },
  );
}

function audiusReq() {
  return new Request('https://solco.test/api/music/audius/tracks/trk-1/download', {
    method: 'POST',
    headers: { origin: 'https://solco.test' },
  });
}
function callAudius(trackId = 'trk-1') {
  return audiusDownload(audiusReq(), { params: Promise.resolve({ trackId }) });
}

function podcastReq() {
  return new Request('https://solco.test/api/music/podcasts/123/episodes/ep-key-1/download', {
    method: 'POST',
    headers: { origin: 'https://solco.test' },
  });
}
function callPodcast(podcastId = '123', episodeKey = 'ep-key-1') {
  return podcastDownload(podcastReq(), { params: Promise.resolve({ podcastId, episodeKey }) });
}

const audiusAttribution = {
  sourceName: 'Audius',
  sourceUrl: 'https://audius.co/artista/brano',
  licenseName: 'Audius Open Music License',
  licenseUrl: 'https://openaudiofoundation.org/open-music-license.pdf',
  creditLine: '© Artista',
};

async function decodeMeta(response: Response) {
  const header = response.headers.get('x-solco-download') ?? '';
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

function firstCallOrder(mock: { mock: { invocationCallOrder: number[] } }): number {
  return mock.mock.invocationCallOrder[0] ?? 0;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue({ id: 'user-1', emailVerified: true });
  mocks.readKey.mockReturnValue('test-key');
  // reserve: null = prenotazione riuscita. release: void.
  mocks.reserve.mockResolvedValue(null);
  mocks.release.mockResolvedValue(undefined);
  mocks.resolveAudius.mockResolvedValue({
    ok: true,
    title: 'Brano aperto',
    artist: 'Artista',
    sourceUrl: 'https://audius.co/artista/brano',
    durationSeconds: 120,
    attribution: audiusAttribution,
  });
  mocks.downloadAudius.mockResolvedValue({
    ok: true,
    bytes: new Uint8Array([1, 2, 3]),
    contentType: 'audio/mpeg',
  });
  mocks.fetchBounded.mockResolvedValue({
    ok: true,
    bytes: new Uint8Array([4, 5]),
    contentType: 'audio/mpeg',
  });
  mocks.getPodcastDetail.mockResolvedValue({
    outcome: 'results',
    podcast: { id: '123', title: 'Show', author: 'Autore', artworkUrl: null, genre: null },
    episodes: [
      {
        key: 'ep-key-1',
        title: 'Episodio 1',
        audioUrl: 'https://cdn.example.com/ep.mp3',
        durationSeconds: 300,
        publishedAt: null,
        description: null,
        artworkUrl: null,
      },
    ],
  });
});

describe('POST /api/music/audius/tracks/[trackId]/download', () => {
  it('rifiuta una richiesta non same-origin prima di tutto', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await callAudius();
    expect(response.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('richiede il login per scaricare', async () => {
    mocks.requireAuth.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const response = await callAudius();
    expect(response.status).toBe(401);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('rifiuta un id brano non valido', async () => {
    const response = await callAudius('bad id');
    expect(response.status).toBe(404);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('risponde source_inactive se manca la chiave Audius', async () => {
    mocks.readKey.mockReturnValue('');
    const response = await callAudius();
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('source_inactive');
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('prenota il limite prima di qualsiasi lavoro e non scarica se è pieno', async () => {
    mocks.reserve.mockResolvedValueOnce(rateLimited());
    const response = await callAudius();
    expect(response.status).toBe(429);
    expect(mocks.reserve).toHaveBeenCalledWith('user-1');
    expect(mocks.resolveAudius).not.toHaveBeenCalled();
    expect(mocks.downloadAudius).not.toHaveBeenCalled();
    // Niente prenotato: niente da rimborsare.
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('nega un brano non scaricabile e rimborsa la prenotazione', async () => {
    mocks.resolveAudius.mockResolvedValueOnce({ ok: false, reason: 'not_downloadable' });
    const response = await callAudius();
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('not_downloadable');
    expect(mocks.downloadAudius).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rimborsa la prenotazione se il brano supera il tetto di dimensione', async () => {
    mocks.downloadAudius.mockResolvedValueOnce({ ok: false, reason: 'too_large' });
    const response = await callAudius();
    expect(response.status).toBe(413);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rimborsa la prenotazione se lo scaricamento non è disponibile', async () => {
    mocks.downloadAudius.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    const response = await callAudius();
    expect(response.status).toBe(502);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('scarica, NON rimborsa in caso di successo e restituisce l’audio con attribuzione', async () => {
    const response = await callAudius();
    expect(response.status).toBe(200);
    expect(mocks.reserve).toHaveBeenCalledWith('user-1');
    // Prenotazione prima della risoluzione; nessun rimborso su successo.
    expect(firstCallOrder(mocks.reserve)).toBeLessThan(firstCallOrder(mocks.resolveAudius));
    expect(mocks.release).not.toHaveBeenCalled();
    const meta = await decodeMeta(response);
    expect(meta).toMatchObject({
      source: 'audius-download',
      downloadKey: 'audius:trk-1',
      title: 'Brano aperto',
      artist: 'Artista',
      attribution: audiusAttribution,
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('POST /api/music/podcasts/[podcastId]/episodes/[episodeKey]/download', () => {
  it('rifiuta una richiesta non same-origin prima di tutto', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await callPodcast();
    expect(response.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
  });

  it('richiede il login', async () => {
    mocks.requireAuth.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const response = await callPodcast();
    expect(response.status).toBe(401);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('rifiuta id non validi', async () => {
    expect((await callPodcast('abc', 'ep-key-1')).status).toBe(404);
    expect((await callPodcast('123', 'chiave/non valida')).status).toBe(404);
    expect(mocks.getPodcastDetail).not.toHaveBeenCalled();
  });

  it('prenota il limite prima di risolvere il feed', async () => {
    mocks.reserve.mockResolvedValueOnce(rateLimited());
    const response = await callPodcast();
    expect(response.status).toBe(429);
    expect(mocks.getPodcastDetail).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('rimborsa e risponde 502 se il podcast non è raggiungibile', async () => {
    mocks.getPodcastDetail.mockResolvedValueOnce({
      outcome: 'unavailable',
      podcast: null,
      episodes: [],
    });
    const response = await callPodcast();
    expect(response.status).toBe(502);
    expect(mocks.fetchBounded).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rimborsa e risponde 404 per un episodio inesistente nel feed', async () => {
    const response = await callPodcast('123', 'ep-mancante1');
    expect(response.status).toBe(404);
    expect(mocks.fetchBounded).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rimborsa se l’enclosure è bloccata (SSRF)', async () => {
    mocks.fetchBounded.mockResolvedValueOnce({ ok: false, reason: 'blocked_host' });
    const response = await callPodcast();
    expect(response.status).toBe(502);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rimborsa un episodio oltre il tetto di dimensione', async () => {
    mocks.fetchBounded.mockResolvedValueOnce({ ok: false, reason: 'too_large' });
    const response = await callPodcast();
    expect(response.status).toBe(413);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('scarica l’enclosure del suo stesso feed e NON rimborsa in caso di successo', async () => {
    const response = await callPodcast();
    expect(response.status).toBe(200);
    expect(mocks.fetchBounded).toHaveBeenCalledWith('https://cdn.example.com/ep.mp3');
    expect(firstCallOrder(mocks.reserve)).toBeLessThan(firstCallOrder(mocks.fetchBounded));
    expect(mocks.release).not.toHaveBeenCalled();
    const meta = await decodeMeta(response);
    expect(meta).toMatchObject({
      source: 'podcast-download',
      downloadKey: 'podcast:123~ep-key-1',
      title: 'Episodio 1',
      artist: 'Autore',
      album: 'Show',
      attribution: { sourceName: 'Show', creditLine: 'Episodio del podcast di Autore' },
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
  });
});
