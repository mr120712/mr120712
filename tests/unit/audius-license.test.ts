// @polsia:user-owned — licence gate: only the Audius Open Music License is playable on Solco.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  budget: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  checkStreamPlay: vi.fn(),
  recordStreamPlay: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { audiusRequestBudget: mocks.budget } }));
vi.mock('@/lib/music/stream-play.server', () => ({
  checkStreamPlay: mocks.checkStreamPlay,
  recordStreamPlay: mocks.recordStreamPlay,
}));
vi.mock('@/lib/business/play-quota.server', () => ({
  playDeniedResponse: (play: { reason: string }) =>
    Response.json(play, { status: play.reason === 'login_required' ? 401 : 402 }),
}));

import { GET as albumDetailRoute } from '@/app/api/music/albums/[albumId]/route';
import { GET as playbackRoute } from '@/app/api/music/audius/tracks/[trackId]/playback/route';
import { GET as streamRoute } from '@/app/api/music/audius/tracks/[trackId]/stream/route';
import { AudiusTrackSearchSchema } from '@/lib/contracts/music';
import {
  AUDIUS_OPEN_MUSIC_LICENSE_URL,
  evaluateAudiusPlayback,
  getAudiusPlaybackReasonText,
  isAudiusOpenMusicLicense,
  mapAudiusAlbumDetail,
  normalizeAudiusTracks,
} from '@/lib/music/audius';
import {
  clearAudiusMetadataCacheForTests,
  createAudiusApiClient,
} from '@/lib/music/audius-api.server';
import {
  createAudiusPlaybackService,
  playbackFailureStatus,
} from '@/lib/music/audius-playback.server';
import { MusicCollectionError, resolveCollectionItem } from '@/lib/music/collections.server';

// The licence labels seen on 100 real trending tracks (api.audius.co, Nov 2026), plus CC BY.
const ALL_RIGHTS_RESERVED = 'All rights reserved';
const CC_BY_NC_ND = 'Attribution-NonCommercial-NoDerivs CC BY-NC-ND';
const CC_BY = 'Attribution CC BY';

function audiusTrack(id: string, license: unknown) {
  return {
    id,
    title: `Brano ${id}`,
    permalink: `https://audius.co/sample-artist/${id}`,
    artwork: { '480x480': 'https://audius.co/images/cover.jpg' },
    duration: 183,
    license,
    copyright_line: { year: 2025, text: 'Sample Artist' },
    is_available: true,
    is_streamable: true,
    is_stream_gated: false,
    access_authorities: [],
    access: { stream: true },
    user: { id: 'artist-71', name: 'Sample Artist', handle: 'sample-artist' },
  };
}

const albumRecord = {
  id: 'album-71',
  is_album: true,
  playlist_name: 'Album di esempio',
  permalink: 'https://audius.co/sample-artist/album-di-esempio',
  artwork: { '480x480': 'https://audius.co/images/album.jpg' },
  track_count: 2,
  user: { id: 'artist-71', name: 'Sample Artist', handle: 'sample-artist' },
};

/** Fake Audius network: host discovery, track detail, album detail and the audio stream. */
function stubAudius(tracks: Record<string, unknown>) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.audius.co') return Response.json({ data: [] });
    const path = url.pathname;
    if (path === '/v1/playlists/album-71') return Response.json({ data: [albumRecord] });
    if (path === '/v1/playlists/album-71/tracks') {
      return Response.json({ data: Object.values(tracks) });
    }
    const stream = /^\/v1\/tracks\/([^/]+)\/stream$/.exec(path);
    if (stream) {
      return new Response(Uint8Array.from([1, 2]), {
        headers: { 'content-type': 'audio/mpeg', 'content-length': '2' },
      });
    }
    const detail = /^\/v1\/tracks\/([^/]+)$/.exec(path);
    const track = detail?.[1] ? tracks[detail[1]] : undefined;
    return track ? Response.json({ data: track }) : Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const streamCalls = (fetcher: ReturnType<typeof stubAudius>) =>
  fetcher.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith('/stream'));

beforeEach(() => {
  vi.stubEnv('AUDIUS_API_KEY', 'server-test-key');
  mocks.budget.upsert.mockReset().mockResolvedValue({});
  mocks.budget.findUnique.mockReset().mockImplementation(async () => ({
    id: 'global',
    monthKey: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`,
    requestCount: 0,
    nextRequestAt: new Date(0),
  }));
  mocks.budget.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.checkStreamPlay.mockReset().mockResolvedValue({
    user: { id: 'free-user' },
    qualifiedId: 'audius:x',
    decision: { allowed: true, counted: true, used: 1, limit: 40 },
  });
  mocks.recordStreamPlay
    .mockReset()
    .mockResolvedValue({ allowed: true, counted: true, used: 1, limit: 40 });
});

afterEach(() => {
  clearAudiusMetadataCacheForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('riconoscimento della Audius Open Music License', () => {
  it('applica la OML quando Audius non indica una licenza o la nomina chiaramente', () => {
    for (const license of [
      null,
      undefined,
      '',
      '   ',
      'Audius Open Music License',
      'open music license v1',
      'OML',
    ]) {
      expect(isAudiusOpenMusicLicense(license), String(license)).toBe(true);
    }
  });

  it('tratta ogni altra etichetta come licenza alternativa, CC BY compresa', () => {
    for (const license of [
      ALL_RIGHTS_RESERVED,
      CC_BY_NC_ND,
      CC_BY,
      'Attribution-ShareAlike CC BY-SA',
      'Licenza indicata da Audius',
      'HOMLAND',
      42,
      {},
    ]) {
      expect(isAudiusOpenMusicLicense(license), String(license)).toBe(false);
    }
  });
});

describe('verdetto di riproduzione con la licenza', () => {
  const base = {
    sourceActive: true,
    isAvailable: true,
    isStreamable: true,
    trackIsStreamGated: false,
    accessCanStream: true,
    accessAuthorities: [],
  };

  it('rende riproducibile solo la OML e mantiene tutti gli altri controlli', () => {
    expect(evaluateAudiusPlayback({ ...base, license: null })).toEqual({
      allowed: true,
      reason: 'ready',
    });
    for (const license of [ALL_RIGHTS_RESERVED, CC_BY_NC_ND, CC_BY]) {
      expect(evaluateAudiusPlayback({ ...base, license })).toEqual({
        allowed: false,
        reason: 'license_not_allowed',
      });
    }
    // Existing checks still apply to OML tracks.
    expect(evaluateAudiusPlayback({ ...base, license: null, accessCanStream: false })).toEqual({
      allowed: false,
      reason: 'access_denied',
    });
    expect(evaluateAudiusPlayback({ ...base, license: null, trackIsStreamGated: true })).toEqual({
      allowed: false,
      reason: 'gated',
    });
    expect(evaluateAudiusPlayback({ ...base, sourceActive: false, license: null })).toEqual({
      allowed: false,
      reason: 'state_unknown',
    });
  });

  it('un brano non disponibile resta tale; una licenza alternativa prevale sul gating', () => {
    expect(
      evaluateAudiusPlayback({ ...base, isStreamable: false, license: ALL_RIGHTS_RESERVED }),
    ).toEqual({ allowed: false, reason: 'not_streamable' });
    expect(
      evaluateAudiusPlayback({ ...base, trackIsStreamGated: true, license: ALL_RIGHTS_RESERVED }),
    ).toEqual({ allowed: false, reason: 'license_not_allowed' });
  });

  it('normalizza i brani reali senza scartarli e spiega il blocco in italiano', () => {
    const tracks = normalizeAudiusTracks(
      {
        data: [
          audiusTrack('oml-null', null),
          audiusTrack('arr', ALL_RIGHTS_RESERVED),
          audiusTrack('cc-by-nc-nd', CC_BY_NC_ND),
          audiusTrack('cc-by', CC_BY),
        ],
      },
      true,
    );
    expect(tracks.map((track) => [track.id, track.playbackEligible, track.playbackReason])).toEqual(
      [
        ['oml-null', true, 'ready'],
        ['arr', false, 'license_not_allowed'],
        ['cc-by-nc-nd', false, 'license_not_allowed'],
        ['cc-by', false, 'license_not_allowed'],
      ],
    );
    expect(tracks[1]).toMatchObject({
      license: ALL_RIGHTS_RESERVED,
      trackUrl: 'https://audius.co/sample-artist/arr',
    });
    expect(AudiusTrackSearchSchema.parse(tracks[1]).playbackReason).toBe('license_not_allowed');
    expect(getAudiusPlaybackReasonText('license_not_allowed')).toBe(
      "L'artista ha scelto una licenza diversa: questo brano si ascolta solo su Audius.",
    );
    expect(AUDIUS_OPEN_MUSIC_LICENSE_URL).toBe(
      'https://openaudiofoundation.org/open-music-license.pdf',
    );
  });

  it('applica la licenza anche alla tracklist di un album', () => {
    const detail = mapAudiusAlbumDetail(
      { data: albumRecord },
      { data: [audiusTrack('oml-null', null), audiusTrack('arr', ALL_RIGHTS_RESERVED)] },
      'album-71',
      true,
    );
    expect(detail?.tracks.map((track) => [track.id, track.playbackEligible])).toEqual([
      ['oml-null', true],
      ['arr', false],
    ]);
  });
});

describe('verifica server-side su ogni percorso che avvia audio Audius', () => {
  const catalog = {
    'oml-null': audiusTrack('oml-null', null),
    arr: audiusTrack('arr', ALL_RIGHTS_RESERVED),
    'cc-by': audiusTrack('cc-by', CC_BY),
  };

  it('le tendenze marcano come non riproducibili i brani con licenza alternativa', async () => {
    const client = createAudiusApiClient({
      apiKey: 'server-test-key',
      fetcher: vi.fn<typeof fetch>(async () => Response.json({ data: Object.values(catalog) })),
      reserve: async () => ({ allowed: true, notBefore: 0 }),
      wait: async () => undefined,
      hostResolver: async () => ['https://test.audius.co'],
    });
    const trending = await client.trending(true);
    expect(trending.tracks.map((track) => [track.id, track.playbackEligible])).toEqual([
      ['oml-null', true],
      ['arr', false],
      ['cc-by', false],
    ]);
  });

  it('il servizio di playback nega con 403 un brano con licenza alternativa', async () => {
    stubAudius(catalog);
    const service = createAudiusPlaybackService();
    expect(await service.check('oml-null')).toEqual({ allowed: true });
    expect(await service.check('arr')).toEqual({ allowed: false, reason: 'license_not_allowed' });
    expect(playbackFailureStatus('license_not_allowed')).toBe(403);
  });

  it('il preflight /playback rifiuta il brano', async () => {
    stubAudius(catalog);
    const response = await playbackRoute(
      new Request('https://solco.test/api/music/audius/tracks/cc-by/playback'),
      { params: Promise.resolve({ trackId: 'cc-by' }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ allowed: false, reason: 'license_not_allowed' });
  });

  it('lo stream rifiuta il brano anche se il client lo chiede direttamente', async () => {
    const fetcher = stubAudius(catalog);
    const response = await streamRoute(
      new Request('https://solco.test/api/music/audius/tracks/arr/stream'),
      { params: Promise.resolve({ trackId: 'arr' }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'license_not_allowed' });
    expect(streamCalls(fetcher)).toHaveLength(0);
    expect(mocks.recordStreamPlay).not.toHaveBeenCalled();
  });

  it('lo stream di un brano OML parte e conta l’ascolto', async () => {
    const fetcher = stubAudius(catalog);
    const response = await streamRoute(
      new Request('https://solco.test/api/music/audius/tracks/oml-null/stream'),
      { params: Promise.resolve({ trackId: 'oml-null' }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(streamCalls(fetcher)).toHaveLength(1);
    expect(mocks.recordStreamPlay).toHaveBeenCalledTimes(1);
  });

  it('preferiti e playlist salvano solo i brani OML', async () => {
    stubAudius(catalog);
    for (const id of ['arr', 'cc-by']) {
      const refused = await resolveCollectionItem('audius', id).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(MusicCollectionError);
      expect(refused).toMatchObject({
        code: 'license_not_allowed',
        message: getAudiusPlaybackReasonText('license_not_allowed'),
      });
    }
    expect(await resolveCollectionItem('audius', 'oml-null')).toMatchObject({
      source: 'audius',
      sourceId: 'oml-null',
      sourceUrl: 'https://audius.co/sample-artist/oml-null',
    });
  });

  it('la scheda album rende ascoltabili solo i brani OML', async () => {
    stubAudius(catalog);
    const response = await albumDetailRoute(
      new Request('https://solco.test/api/music/albums/album-71'),
      {
        params: Promise.resolve({ albumId: 'album-71' }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tracks: Array<{ id: string; fullAccess: string; playbackReason: string }>;
    };
    expect(body.tracks.map((track) => [track.id, track.fullAccess, track.playbackReason])).toEqual([
      ['oml-null', 'available', 'ready'],
      ['arr', 'unavailable', 'license_not_allowed'],
      ['cc-by', 'unavailable', 'license_not_allowed'],
    ]);
  });
});
