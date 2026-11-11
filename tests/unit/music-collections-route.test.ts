// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  userId: 'account-a' as string | null,
  sameOrigin: true,
  counter: 0,
  collections: [] as Array<{ id: string; userId: string; name: string; kind: string; createdAt: Date }>,
  items: [] as Array<{
    id: string; collectionId: string; source: 'audius' | 'youtube'; sourceId: string;
    title: string; creatorName: string; artworkUrl: string | null; sourceUrl: string;
    artistUrl: string | null; durationSeconds: number | null; createdAt: Date; expiresAt: Date | null;
  }>,
  resolveMetadata: vi.fn(),
}));

function ownedCollection(id: string, userId: string) {
  return memory.collections.find((item) => item.id === id && item.userId === userId);
}

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    userMusicCollection: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string; name?: string } }) =>
        memory.collections.find((item) =>
          (!where.id || item.id === where.id) &&
          (!where.userId || item.userId === where.userId) &&
          (!where.name || item.name === where.name),
        ) ?? null),
      create: vi.fn(async ({ data }: { data: { userId: string; name: string; kind: string } }) => {
        const row = { id: `collection-${++memory.counter}`, ...data, createdAt: new Date() };
        memory.collections.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; userId: string; kind: string } }) => {
        const row = ownedCollection(where.id, where.userId);
        if (!row || row.kind !== where.kind) return { count: 0 };
        memory.collections = memory.collections.filter((item) => item.id !== row.id);
        memory.items = memory.items.filter((item) => item.collectionId !== row.id);
        return { count: 1 };
      }),
    },
    userMusicCollectionItem: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; collectionId: string; collection: { userId: string } } }) => {
        const parent = ownedCollection(where.collectionId, where.collection.userId);
        return parent ? memory.items.find((item) => item.id === where.id && item.collectionId === parent.id) ?? null : null;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; collectionId: string; collection: { userId: string } } }) => {
        const parent = ownedCollection(where.collectionId, where.collection.userId);
        if (!parent) return { count: 0 };
        const before = memory.items.length;
        memory.items = memory.items.filter((item) => !(item.id === where.id && item.collectionId === parent.id));
        return { count: before - memory.items.length };
      }),
      upsert: vi.fn(async ({
        where,
        create,
        update,
      }: {
        where: { collectionId_source_sourceId: { collectionId: string; source: 'audius' | 'youtube'; sourceId: string } };
        create: Omit<(typeof memory.items)[number], 'id' | 'createdAt'>;
        update: Partial<(typeof memory.items)[number]>;
      }) => {
        const key = where.collectionId_source_sourceId;
        const existing = memory.items.find((item) => item.collectionId === key.collectionId && item.source === key.source && item.sourceId === key.sourceId);
        if (existing) Object.assign(existing, update);
        else memory.items.push({ id: `item-${++memory.counter}`, createdAt: new Date(), ...create });
      }),
    },
  },
}));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (!memory.userId) throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    return { id: memory.userId, email: `${memory.userId}@example.test` };
  }),
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => memory.sameOrigin }));
vi.mock('@/lib/music/collections.server', () => ({
  MusicCollectionError: class MusicCollectionError extends Error {},
  ensureFavoritesCollection: vi.fn(async (userId: string) => {
    const existing = memory.collections.find((item) => item.userId === userId && item.name === 'Preferiti');
    if (existing) return existing;
    const row = { id: `collection-${++memory.counter}`, userId, name: 'Preferiti', kind: 'favorites', createdAt: new Date() };
    memory.collections.push(row);
    return row;
  }),
  resolveCollectionItem: (source: 'audius' | 'youtube', sourceId: string) => memory.resolveMetadata(source, sourceId),
  isFavoritesName: (name: string) => name.trim().toLowerCase() === 'preferiti',
  getUserMusicCollections: vi.fn(async (userId: string) => {
    await (async () => {
      const existing = memory.collections.find((item) => item.userId === userId && item.name === 'Preferiti');
      if (!existing) memory.collections.push({ id: `collection-${++memory.counter}`, userId, name: 'Preferiti', kind: 'favorites', createdAt: new Date() });
    })();
    return memory.collections.filter((item) => item.userId === userId).map((collection) => ({
      id: collection.id,
      name: collection.name,
      kind: collection.kind,
      createdAt: collection.createdAt.toISOString(),
      items: memory.items.filter((item) => item.collectionId === collection.id).map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        expiresAt: item.expiresAt?.toISOString() ?? null,
      })),
    }));
  }),
}));

import { GET, POST } from '@/app/api/music/collections/route';

function post(body: unknown) {
  return POST(new Request('https://solco.test/api/music/collections', {
    method: 'POST',
    headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  memory.userId = 'account-a';
  memory.sameOrigin = true;
  memory.counter = 0;
  memory.collections = [];
  memory.items = [];
  memory.resolveMetadata.mockReset().mockImplementation(async (source: 'audius' | 'youtube', sourceId: string) => ({
    source,
    sourceId,
    title: source === 'youtube' ? 'Video API' : 'Brano API',
    creatorName: 'Artista API',
    artworkUrl: null,
    sourceUrl: source === 'youtube' ? `https://www.youtube.com/watch?v=${sourceId}` : `https://audius.co/artist/${sourceId}`,
    artistUrl: source === 'youtube' ? null : 'https://audius.co/artist',
    durationSeconds: source === 'youtube' ? null : 180,
    expiresAt: source === 'youtube' ? new Date(Date.now() + 29 * 24 * 60 * 60 * 1000) : null,
  }));
});

describe('raccolte musicali per account', () => {
  it('salva Audius e YouTube nei preferiti e in playlist e rilegge i dati persistiti', async () => {
    const create = await post({ action: 'create_playlist', name: 'Viaggio' });
    const created = await create.json();
    expect(create.status, JSON.stringify(created)).toBe(200);
    const playlist = created.collections.find((item: { name: string }) => item.name === 'Viaggio');
    expect(playlist).toBeDefined();

    await post({ action: 'favorite', source: 'audius', sourceId: 'track-71' });
    await post({ action: 'favorite', source: 'youtube', sourceId: 'dQw4w9WgXcQ' });
    await post({ action: 'add', collectionId: playlist.id, source: 'audius', sourceId: 'track-71' });
    await post({ action: 'add', collectionId: playlist.id, source: 'youtube', sourceId: 'dQw4w9WgXcQ' });

    const response = await GET(new Request('https://solco.test/api/music/collections'));
    const body = await response.json();
    const favorites = body.collections.find((item: { kind: string }) => item.kind === 'favorites');
    const savedPlaylist = body.collections.find((item: { name: string }) => item.name === 'Viaggio');
    expect(favorites.items.map((item: { source: string }) => item.source).sort()).toEqual(['audius', 'youtube']);
    expect(savedPlaylist.items.map((item: { source: string }) => item.source).sort()).toEqual(['audius', 'youtube']);
    expect(savedPlaylist.items.find((item: { source: string }) => item.source === 'youtube')).toMatchObject({
      sourceId: 'dQw4w9WgXcQ', title: 'Video API', expiresAt: expect.any(String),
    });

    for (const collection of [favorites, savedPlaylist]) {
      for (const item of collection.items) {
        await post({ action: 'remove_item', collectionId: collection.id, itemId: item.id });
      }
    }
    const afterRemoval = await GET(new Request('https://solco.test/api/music/collections'));
    const removedCollections = (await afterRemoval.json()).collections as Array<{ items: unknown[] }>;
    expect(removedCollections.every((collection) => collection.items.length === 0)).toBe(true);
  });

  it('isola letture, aggiunte e rimozioni tra account', async () => {
    const create = await post({ action: 'create_playlist', name: 'Account A' });
    const created = await create.json();
    const accountAPlaylistId = created.collections.find((item: { name: string }) => item.name === 'Account A').id as string;
    const added = await post({ action: 'add', collectionId: accountAPlaylistId, source: 'audius', sourceId: 'track-71' });
    const addedBody = await added.json();
    const accountAItemId = addedBody.collections.find((item: { name: string }) => item.name === 'Account A').items[0].id as string;

    memory.userId = 'account-b';
    const accountB = await GET(new Request('https://solco.test/api/music/collections'));
    expect((await accountB.json()).collections.map((item: { name: string }) => item.name)).toEqual(['Preferiti']);

    const forbiddenAdd = await post({ action: 'add', collectionId: accountAPlaylistId, source: 'youtube', sourceId: 'dQw4w9WgXcQ' });
    const forbiddenRemove = await post({ action: 'remove_item', collectionId: accountAPlaylistId, itemId: accountAItemId });
    expect(forbiddenAdd.status).toBe(404);
    expect(forbiddenRemove.status).toBe(404);

    memory.userId = 'account-a';
    const accountAFinal = await GET(new Request('https://solco.test/api/music/collections'));
    const playlist = (await accountAFinal.json()).collections.find((item: { id: string }) => item.id === accountAPlaylistId);
    expect(playlist.items).toHaveLength(1);
    expect(playlist.items[0].sourceId).toBe('track-71');
  });

  it('richiede same-origin alle mutazioni e autenticazione alle raccolte', async () => {
    memory.sameOrigin = false;
    const forbidden = await post({ action: 'create_playlist', name: 'No CSRF' });
    expect(forbidden.status).toBe(403);
    expect(memory.collections).toHaveLength(0);

    memory.sameOrigin = true;
    memory.userId = null;
    const unauthorized = await post({ action: 'create_playlist', name: 'No sessione' });
    expect(unauthorized.status).toBe(401);
  });
});
