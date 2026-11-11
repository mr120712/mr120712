// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => null),
    findUnique: vi.fn(async (): Promise<unknown> => null),
    count: vi.fn(async () => 0),
    upsert: vi.fn(async () => ({})),
    create: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 1 })),
    updateMany: vi.fn(async () => ({ count: 1 })),
  });
  return {
    enforceRateLimit: vi.fn(async (): Promise<Response | null> => null),
    resolveCollectionItem: vi.fn(),
    prisma: {
      userMusicCollection: model(),
      userMusicCollectionItem: model(),
      userSavedStation: model(),
      userPodcastFollow: model(),
      userMusicFolder: model(),
      userPlaybackHistory: model(),
      userHiddenItem: model(),
    },
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ id: 'account-a', email: 'a@example.test' })),
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => true }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/music/collections.server', () => ({
  MAX_PLAYLISTS_PER_USER: 100,
  MAX_ITEMS_PER_COLLECTION: 500,
  MusicCollectionError: class MusicCollectionError extends Error {},
  ensureFavoritesCollection: vi.fn(async () => ({
    id: 'favorites-1',
    userId: 'account-a',
    name: 'Preferiti',
    kind: 'favorites',
  })),
  resolveCollectionItem: mocks.resolveCollectionItem,
  isFavoritesName: (name: string) => name.trim().toLowerCase() === 'preferiti',
  getUserMusicCollections: vi.fn(async () => []),
}));

import { POST } from '@/app/api/music/collections/route';
import { applyLibraryMutation, getLibrary, LIBRARY_LIMITS } from '@/lib/music/library.server';
import { fetchYouTubePlaylist } from '@/lib/music/youtube-playlist-import.server';

function post(body: unknown) {
  return POST(
    new Request('https://solco.test/api/music/collections', {
      method: 'POST',
      headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveCollectionItem.mockResolvedValue({
    source: 'youtube',
    sourceId: 'dQw4w9WgXcQ',
    title: 'Video',
    creatorName: 'Canale',
    artworkUrl: null,
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    artistUrl: null,
    durationSeconds: null,
    expiresAt: null,
  });
});

describe('POST /api/music/collections: limiti', () => {
  it('applica il limite library.write per utente prima di leggere il corpo', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(
      Response.json({ error: 'rate_limited' }, { status: 429 }),
    );
    const response = await post({ action: 'favorite', source: 'youtube', sourceId: 'dQw4w9WgXcQ' });
    expect(response.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('library.write', 'user:account-a');
    expect(mocks.resolveCollectionItem).not.toHaveBeenCalled();
    expect(mocks.prisma.userMusicCollectionItem.upsert).not.toHaveBeenCalled();
  });

  it('rifiuta corpi troppo grandi con 413', async () => {
    const response = await post({ action: 'create_playlist', name: 'x'.repeat(8 * 1024) });
    expect(response.status).toBe(413);
    expect(mocks.prisma.userMusicCollection.create).not.toHaveBeenCalled();
  });

  it('blocca la creazione oltre il limite di playlist con 409', async () => {
    mocks.prisma.userMusicCollection.count.mockResolvedValueOnce(100);
    const response = await post({ action: 'create_playlist', name: 'Nuova' });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('limit_reached');
    expect(body.message).toContain('100 playlist');
    expect(mocks.prisma.userMusicCollection.count).toHaveBeenCalledWith({
      where: { userId: 'account-a', kind: 'playlist' },
    });
    expect(mocks.prisma.userMusicCollection.create).not.toHaveBeenCalled();
  });

  it('crea la playlist sotto il limite', async () => {
    mocks.prisma.userMusicCollection.count.mockResolvedValueOnce(99);
    const response = await post({ action: 'create_playlist', name: 'Nuova' });
    expect(response.status).toBe(200);
    expect(mocks.prisma.userMusicCollection.create).toHaveBeenCalledOnce();
  });

  it('a raccolta piena non chiama YouTube/Audius per un nuovo elemento', async () => {
    mocks.prisma.userMusicCollectionItem.count.mockResolvedValueOnce(500);
    const response = await post({ action: 'favorite', source: 'youtube', sourceId: 'dQw4w9WgXcQ' });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'limit_reached' });
    expect(body.message).toContain('500');
    expect(mocks.resolveCollectionItem).not.toHaveBeenCalled();
    expect(mocks.prisma.userMusicCollectionItem.upsert).not.toHaveBeenCalled();
  });

  it('a raccolta piena aggiorna comunque un elemento già salvato', async () => {
    mocks.prisma.userMusicCollectionItem.count.mockResolvedValueOnce(500);
    mocks.prisma.userMusicCollectionItem.findUnique.mockResolvedValueOnce({ id: 'item-1' });
    const response = await post({ action: 'favorite', source: 'youtube', sourceId: 'dQw4w9WgXcQ' });
    expect(response.status).toBe(200);
    expect(mocks.resolveCollectionItem).toHaveBeenCalledOnce();
    expect(mocks.prisma.userMusicCollectionItem.upsert).toHaveBeenCalledOnce();
  });
});

describe('Libreria: limiti per utente', () => {
  const station = {
    stationId: 'station-1',
    name: 'Radio',
    artworkUrl: null,
    country: null,
    tags: null,
    homepage: null,
  };

  it('limita le letture di getLibrary', async () => {
    await getLibrary('account-a');
    for (const [model, take] of [
      [mocks.prisma.userSavedStation, LIBRARY_LIMITS.stations],
      [mocks.prisma.userPodcastFollow, LIBRARY_LIMITS.podcasts],
      [mocks.prisma.userMusicFolder, LIBRARY_LIMITS.folders],
      [mocks.prisma.userHiddenItem, LIBRARY_LIMITS.hidden],
    ] as const) {
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ take }));
    }
    expect(mocks.prisma.userMusicCollection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: expect.any(Number) }),
    );
  });

  it('non salva una nuova radio oltre il limite', async () => {
    mocks.prisma.userSavedStation.count.mockResolvedValueOnce(LIBRARY_LIMITS.stations);
    await expect(
      applyLibraryMutation('account-a', { action: 'save_station', station }),
    ).rejects.toMatchObject({ code: 'limit_reached' });
    expect(mocks.prisma.userSavedStation.upsert).not.toHaveBeenCalled();
  });

  it('aggiorna una radio già salvata anche al limite', async () => {
    mocks.prisma.userSavedStation.count.mockResolvedValueOnce(LIBRARY_LIMITS.stations);
    mocks.prisma.userSavedStation.findUnique.mockResolvedValueOnce({ id: 'row-1' });
    await applyLibraryMutation('account-a', { action: 'save_station', station });
    expect(mocks.prisma.userSavedStation.upsert).toHaveBeenCalledOnce();
  });

  it('non crea cartelle oltre il limite', async () => {
    mocks.prisma.userMusicFolder.count.mockResolvedValueOnce(LIBRARY_LIMITS.folders);
    await expect(
      applyLibraryMutation('account-a', { action: 'create_folder', name: 'Altra' }),
    ).rejects.toMatchObject({ code: 'limit_reached' });
    expect(mocks.prisma.userMusicFolder.create).not.toHaveBeenCalled();
  });

  it('elimina la cronologia oltre il limite dopo un ascolto', async () => {
    mocks.prisma.userPlaybackHistory.findMany.mockResolvedValueOnce([
      { id: 'old-1' },
      { id: 'old-2' },
    ]);
    await applyLibraryMutation('account-a', {
      action: 'record_play',
      track: {
        qualifiedId: 'radio:station-1',
        title: 'Radio',
        artistName: 'Italia',
        artworkUrl: null,
        sourceLabel: 'Radio dal vivo',
        sourceUrl: null,
        albumId: null,
        durationSeconds: null,
        playbackMode: 'radio',
      },
    });
    expect(mocks.prisma.userPlaybackHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'account-a' }, skip: LIBRARY_LIMITS.history }),
    );
    expect(mocks.prisma.userPlaybackHistory.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'account-a', id: { in: ['old-1', 'old-2'] } },
    });
  });
});

describe('import playlist YouTube: pagine limitate', () => {
  it('smette di sfogliare una playlist di soli video non disponibili', async () => {
    const privateItem = {
      contentDetails: { videoId: 'bbbbbbbbbbb' },
      snippet: { title: 'Private video' },
    };
    let page = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/playlists')) {
        return Response.json({ items: [{ snippet: { title: 'Solo privati' } }] });
      }
      page += 1;
      return Response.json({
        items: Array.from({ length: 50 }, () => privateItem),
        nextPageToken: `p${page + 1}`,
      });
    });
    const result = await fetchYouTubePlaylist(
      'PLabcdefghij1234567890',
      'key',
      fetcher as unknown as typeof fetch,
    );
    expect(result.videos).toEqual([]);
    expect(page).toBeLessThanOrEqual(4);
    expect(result.skipped).toBe(page * 50);
  });
});
