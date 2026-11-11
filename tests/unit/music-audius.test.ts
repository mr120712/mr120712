// @polsia:user-owned
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { audiusRequestBudget: databaseMocks } }));

import { AudiusAlbumDetailSchema, MusicHomeResponseSchema } from '@/lib/contracts/music';
import {
  evaluateAudiusPlayback,
  mapAudiusAlbumDetail,
  normalizeAudiusAlbums,
  normalizeAudiusArtists,
  normalizeAudiusTracks,
} from '@/lib/music/audius';
import {
  AUDIUS_APP_NAME,
  AUDIUS_METADATA_CACHE_TTL_MS,
  AudiusApiError,
  clearAudiusMetadataCacheForTests,
  createAudiusApiClient,
} from '@/lib/music/audius-api.server';
import {
  getAudiusActivation,
  getAudiusHomeCatalog,
  runAudiusSearch,
  runAudiusTrending,
} from '@/lib/music/audius-source.server';

const trackFixture = {
  id: 'track-71',
  title: 'Brano di esempio',
  permalink: 'https://audius.co/sample-artist/brano-di-esempio',
  artwork: { '480x480': 'https://audius.co/images/cover.jpg' },
  duration: 183,
  genre: 'Electronic',
  // Real Audius shape: no label means the default Audius Open Music License (OML §1.1).
  license: null,
  copyright_line: { year: 2025, text: 'Sample Artist' },
  producer_copyright_line: { year: 2025, text: 'Sample Producer' },
  is_available: true,
  is_streamable: true,
  is_stream_gated: false,
  access_authorities: [],
  access: { stream: true },
  user: {
    id: 'artist-71',
    name: 'Sample Artist',
    handle: 'sample-artist',
    profile_picture: { '150x150': 'https://audius.co/images/profile.jpg' },
  },
};

const albumFixture = {
  id: 'album-71',
  is_album: true,
  playlist_name: 'Album di esempio',
  permalink: 'https://audius.co/sample-artist/album-di-esempio',
  artwork: { '480x480': 'https://audius.co/images/album.jpg' },
  release_date: '2026-06-12',
  track_count: 1,
  user: { id: 'artist-71', name: 'Sample Artist', handle: 'sample-artist' },
};

afterEach(() => {
  clearAudiusMetadataCacheForTests();
  vi.unstubAllEnvs();
});

describe('metadati e autorizzazione Audius', () => {
  it('lascia il catalogo indisponibile senza chiave e senza fabbricare risultati', async () => {
    vi.stubEnv('AUDIUS_API_KEY', '');
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const catalog = MusicHomeResponseSchema.parse(await getAudiusHomeCatalog());
    expect(catalog.sourceStatus).toMatchObject({
      active: false,
      unavailableReason: 'not_configured',
    });
    expect(catalog.trending).toEqual({ outcome: 'unavailable', tracks: [] });
    expect(catalog.releases.albums).toEqual([]);
    expect(catalog.playlists.playlists).toEqual([]);
    expect(catalog.artists.artists).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('normalizza titolo, artista, artwork e attribuzione da Audius', () => {
    const [track] = normalizeAudiusTracks({ data: [trackFixture] }, true);
    const [artist] = normalizeAudiusArtists({ data: [trackFixture.user] });
    expect(track).toMatchObject({
      provider: 'audius',
      id: 'track-71',
      title: 'Brano di esempio',
      artistName: 'Sample Artist',
      artistHandle: 'sample-artist',
      artistUrl: 'https://audius.co/sample-artist',
      trackUrl: 'https://audius.co/sample-artist/brano-di-esempio',
      artworkUrl: 'https://audius.co/images/cover.jpg',
      licensorName: 'Sample Artist',
      copyrightNotice: '© 2025 Sample Artist',
      producerCopyrightNotice: '© 2025 Sample Producer',
      attributionComplete: true,
    });
    expect(artist?.profileUrl).toBe('https://audius.co/sample-artist');
    expect(JSON.stringify(track)).not.toMatch(/api_key|streamUrl|audioBytes/i);
  });

  it('normalizza anche la risposta oggetto usata dal singolo endpoint tracks/{id}', () => {
    expect(normalizeAudiusTracks({ data: trackFixture }, true)).toMatchObject([
      {
        id: 'track-71',
        title: 'Brano di esempio',
        artistName: 'Sample Artist',
        artistUrl: 'https://audius.co/sample-artist',
        artworkUrl: 'https://audius.co/images/cover.jpg',
        playbackEligible: true,
      },
    ]);
  });

  it('scarta i brani senza copertina, artista o profilo verificabili', () => {
    expect(normalizeAudiusTracks({ data: [{ ...trackFixture, artwork: null }] }, true)).toEqual([]);
    expect(normalizeAudiusTracks({ data: [{ ...trackFixture, user: null }] }, true)).toEqual([]);
  });

  it('mappa album e tracklist reali nel contratto senza creare brani sostitutivi', () => {
    expect(normalizeAudiusAlbums({ data: [albumFixture] })).toMatchObject([
      {
        id: 'album-71',
        qualifiedId: 'audius:album:album-71',
        title: 'Album di esempio',
        artistName: 'Sample Artist',
        trackCount: 1,
      },
    ]);
    expect(normalizeAudiusAlbums({ data: [{ ...albumFixture, is_album: false }] })).toEqual([]);

    const detail = mapAudiusAlbumDetail(
      { data: albumFixture },
      { data: [trackFixture] },
      'album-71',
      true,
    );
    expect(detail).not.toBeNull();
    expect(
      AudiusAlbumDetailSchema.parse({
        album: detail?.album,
        tracks: detail?.tracks.map((track) => ({ ...track, fullAccess: 'rights_unverified' })),
      }),
    ).toMatchObject({
      album: { id: 'album-71', title: 'Album di esempio' },
      tracks: [{ id: 'track-71', albumId: 'album-71', fullAccess: 'rights_unverified' }],
    });
    expect(
      mapAudiusAlbumDetail({ data: [] }, { data: [trackFixture] }, 'album-71', true),
    ).toBeNull();
    expect(
      mapAudiusAlbumDetail({ data: albumFixture }, { data: null }, 'album-71', true)?.tracks,
    ).toEqual([]);
  });

  it('non inventa l’artista o il link quando l’attribuzione manca', () => {
    expect(
      normalizeAudiusTracks({ data: [{ ...trackFixture, user: { id: 'artist-71' } }] }, true),
    ).toEqual([]);
    expect(normalizeAudiusArtists({ data: [{ id: 'artist-72', name: 'Senza handle' }] })).toEqual(
      [],
    );
  });

  it('riproduce solo i brani con la Open Music License (licenza vuota o OML)', () => {
    const base = {
      sourceActive: true,
      isAvailable: true,
      isStreamable: true,
      trackIsStreamGated: false,
      accessCanStream: true,
      accessAuthorities: null,
    };
    for (const license of [null, undefined, '', '  ', 'Audius Open Music License', 'OML']) {
      expect(evaluateAudiusPlayback({ ...base, license })).toEqual({
        allowed: true,
        reason: 'ready',
      });
    }
    for (const license of [
      'All rights reserved',
      'Attribution-NonCommercial-NoDerivs CC BY-NC-ND',
      'Attribution CC BY',
      'qualcos’altro',
      42,
    ]) {
      expect(evaluateAudiusPlayback({ ...base, license })).toEqual({
        allowed: false,
        reason: 'license_not_allowed',
      });
    }
  });

  it('mantiene separati stream consentito, negato e sconosciuto', () => {
    const base = {
      sourceActive: true,
      isAvailable: true,
      isStreamable: true,
      license: null,
      trackIsStreamGated: false,
      accessAuthorities: [],
    };
    expect(evaluateAudiusPlayback({ ...base, accessCanStream: true })).toEqual({
      allowed: true,
      reason: 'ready',
    });
    // What the Audius API really sends for open tracks: access_authorities null.
    expect(
      evaluateAudiusPlayback({ ...base, accessCanStream: true, accessAuthorities: null }),
    ).toEqual({ allowed: true, reason: 'ready' });
    expect(evaluateAudiusPlayback({ ...base, accessCanStream: false })).toEqual({
      allowed: false,
      reason: 'access_denied',
    });
    expect(evaluateAudiusPlayback({ ...base, accessCanStream: null })).toEqual({
      allowed: false,
      reason: 'access_unknown',
    });
    expect(evaluateAudiusPlayback({ ...base, accessCanStream: true, isStreamable: false })).toEqual(
      { allowed: false, reason: 'not_streamable' },
    );
    expect(evaluateAudiusPlayback({ ...base, accessCanStream: true, isAvailable: null })).toEqual({
      allowed: false,
      reason: 'state_unknown',
    });
    expect(
      evaluateAudiusPlayback({ ...base, accessCanStream: true, accessAuthorities: undefined }),
    ).toEqual({
      allowed: false,
      reason: 'access_unknown',
    });
    expect(
      evaluateAudiusPlayback({ ...base, accessCanStream: true, accessAuthorities: ['wallet-71'] }),
    ).toEqual({
      allowed: false,
      reason: 'gated',
    });
    expect(
      evaluateAudiusPlayback({ ...base, accessCanStream: true, trackIsStreamGated: true }),
    ).toEqual({
      allowed: false,
      reason: 'gated',
    });
  });

  it('non rende ascoltabile una risposta con accesso o stato pubblico assente', () => {
    const missingAccess = normalizeAudiusTracks(
      {
        data: [{ ...trackFixture, access: undefined }],
      },
      true,
    );
    const missingAuthorities = normalizeAudiusTracks(
      {
        data: [{ ...trackFixture, access_authorities: undefined }],
      },
      true,
    );
    expect(missingAccess[0]).toMatchObject({
      playbackEligible: false,
      playbackReason: 'access_unknown',
    });
    expect(missingAuthorities[0]).toMatchObject({
      playbackEligible: false,
      playbackReason: 'access_unknown',
    });
  });

  it('attiva la fonte quando esiste la credenziale senza richiedere gate editoriali separati', () => {
    const activation = getAudiusActivation('');
    expect(activation.active).toBe(false);
    expect(activation.blockers).toEqual(['credential_missing']);
    expect(getAudiusActivation('fixture-server-key')).toMatchObject({ active: true, blockers: [] });
  });

  it('inoltra sia un titolo sia un nome artista alla ricerca Audius', async () => {
    const search = vi.fn(async () => ({
      tracks: [],
      artists: [],
      outcome: 'no_results' as const,
      retryAfterSeconds: undefined,
    }));
    const client = { search };
    await runAudiusSearch('Titolo Cercato', true, client);
    await runAudiusSearch('Artista Cercato', true, client);
    expect(search).toHaveBeenNthCalledWith(1, 'Titolo Cercato', true);
    expect(search).toHaveBeenNthCalledWith(2, 'Artista Cercato', true);
  });

  it('non impone paywall o durata di anteprima quando Audius autorizza lo stream', () => {
    const [track] = normalizeAudiusTracks(
      { data: [{ ...trackFixture, license: null, copyright_line: undefined }] },
      true,
    );
    expect(track).toMatchObject({
      title: 'Brano di esempio',
      artistName: 'Sample Artist',
      artistUrl: 'https://audius.co/sample-artist',
      playbackEligible: true,
      playbackReason: 'ready',
    });
  });

  it('distingue limite Audius nelle tendenze e non interroga una fonte disattivata', async () => {
    const limited = await runAudiusTrending(true, {
      trending: vi.fn(async () => {
        throw new AudiusApiError('rate_limited', 'limit', 37);
      }),
    });
    expect(limited).toMatchObject({ outcome: 'unavailable', retryAfterSeconds: 37 });

    const neverQuery = vi.fn();
    const inactive = await runAudiusTrending(false, { trending: neverQuery });
    expect(inactive).toEqual({ tracks: [], outcome: 'inactive' });
    expect(neverQuery).not.toHaveBeenCalled();
  });
});

describe('client Audius: host, attribuzione e cache', () => {
  it('scopre un host Audius valido, aggiunge app_name=solco e passa al successivo se il primo fallisce', async () => {
    clearAudiusMetadataCacheForTests();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.audius.co') {
        return Response.json({ data: ['https://first.audius.co', 'https://malicious.example'] });
      }
      if (url.hostname === 'first.audius.co') return Response.json({}, { status: 503 });
      if (url.pathname.endsWith('/tracks/search')) return Response.json({ data: [trackFixture] });
      if (url.pathname.endsWith('/users/search')) {
        return Response.json({
          data: [
            {
              id: 'artist-71',
              name: 'Sample Artist',
              handle: 'sample-artist',
              profile_picture: { '150x150': 'https://audius.co/images/profile.jpg' },
            },
          ],
        });
      }
      return Response.json({ data: [] });
    });
    const client = createAudiusApiClient({
      apiKey: 'server-test-key',
      fetcher,
      reserve: async () => ({ allowed: true, notBefore: 0 }),
      wait: async () => undefined,
      now: () => 100,
    });

    const results = await client.search('Electronic', true);
    const calls = fetcher.mock.calls.map(([input]) => new URL(String(input)));
    expect(results).toMatchObject({ outcome: 'results', tracks: [{ id: 'track-71' }] });
    expect(results.artists).toMatchObject([
      { name: 'Sample Artist', artworkUrl: 'https://audius.co/images/profile.jpg' },
    ]);
    expect(calls[0]?.searchParams.get('app_name')).toBe(AUDIUS_APP_NAME);
    expect(calls.find((url) => url.hostname === 'first.audius.co')?.pathname).toBe(
      '/v1/tracks/search',
    );
    expect(calls.filter((url) => url.pathname.endsWith('/tracks/search'))[1]?.hostname).toBe(
      'discoveryprovider.audius.co',
    );
    expect(calls.every((url) => !url.hostname.endsWith('malicious.example'))).toBe(true);
    expect(JSON.stringify(results)).not.toContain('server-test-key');
  });

  it('riusa solo metadati per dieci minuti e richiede ogni stream audio senza cache', async () => {
    clearAudiusMetadataCacheForTests();
    let now = 1_000;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tracks/search')) return Response.json({ data: [trackFixture] });
      if (url.pathname.endsWith('/users/search')) {
        return Response.json({
          data: [
            {
              id: 'artist-71',
              name: 'Sample Artist',
              handle: 'sample-artist',
              profile_picture: { '150x150': 'https://audius.co/images/profile.jpg' },
            },
          ],
        });
      }
      if (url.pathname.endsWith('/stream')) {
        return new Response('audio-bytes', { headers: { 'Content-Type': 'audio/mpeg' } });
      }
      return Response.json({ data: [] });
    });
    const client = createAudiusApiClient({
      apiKey: 'cache-test-key',
      fetcher,
      reserve: async () => ({ allowed: true, notBefore: now }),
      wait: async () => undefined,
      hostResolver: async () => ['https://cache.audius.co'],
      now: () => now,
    });

    await client.search('ambient', true);
    const afterFirstSearch = fetcher.mock.calls.length;
    await client.search('ambient', true);
    expect(fetcher).toHaveBeenCalledTimes(afterFirstSearch);

    now += AUDIUS_METADATA_CACHE_TTL_MS;
    await client.search('ambient', true);
    expect(fetcher.mock.calls.length).toBe(afterFirstSearch * 2);

    const firstStream = await client.streamTrack('track-71');
    await firstStream.arrayBuffer();
    const secondStream = await client.streamTrack('track-71');
    await secondStream.arrayBuffer();
    const streamCalls = fetcher.mock.calls.filter(([input]) => String(input).includes('/stream'));
    expect(streamCalls).toHaveLength(2);
    expect(streamCalls.every(([, init]) => init?.cache === 'no-store')).toBe(true);
    expect(AUDIUS_METADATA_CACHE_TTL_MS).toBe(10 * 60 * 1000);
  });
});
