// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CollectionRow = {
  id: string;
  userId: string;
  name: string;
  kind: string;
  folderId: string | null;
  shareId: string | null;
  sharedAt: Date | null;
  description?: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type ItemRow = {
  id: string;
  collectionId: string;
  source: string;
  sourceId: string;
  title: string | null;
  creatorName: string | null;
  artworkUrl: string | null;
  sourceUrl: string | null;
  artistUrl: string | null;
  durationSeconds: number | null;
  createdAt: Date;
  expiresAt: Date | null;
};

const memory = vi.hoisted(() => ({
  userId: 'owner' as string | null,
  emailVerified: true,
  phoneNumberVerified: null as boolean | null,
  sameOrigin: true,
  counter: 0,
  users: [] as Array<{ id: string; name: string; email: string; banned?: boolean | null }>,
  collections: [] as CollectionRow[],
  items: [] as ItemRow[],
  rateLimited: false,
}));

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
  findUnique: vi.fn(),
  // Byte buffers to return from randomBytes before falling back to real randomness.
  forcedRandom: [] as Buffer[],
  /** Ogni chiamata a userMusicCollection.updateMany, per controllare where e data esatti. */
  collectionUpdates: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = ((size: number) =>
    mocks.forcedRandom.shift() ?? actual.randomBytes(size)) as typeof actual.randomBytes;
  return { ...actual, default: { ...actual, randomBytes }, randomBytes };
});

function matches<T extends object>(row: T, where: Record<string, unknown> = {}) {
  return Object.entries(where).every(
    ([key, value]) => value === undefined || (row as Record<string, unknown>)[key] === value,
  );
}

function withItems(row: CollectionRow, take?: number) {
  const items = memory.items
    .filter((item) => item.collectionId === row.id)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  return { ...row, items: take ? items.slice(0, take) : items };
}

vi.mock('server-only', () => ({}));
vi.mock('@/lib/site', () => ({ siteUrl: 'https://solco.test' }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => memory.sameOrigin }));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (!memory.userId) throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    return {
      id: memory.userId,
      email: `${memory.userId}@example.test`,
      emailVerified: memory.emailVerified,
      phoneNumberVerified: memory.phoneNumberVerified,
    };
  }),
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null, headers: Headers) =>
    userId ? `user:${userId}` : headers.get('x-real-ip') ? `ip:${headers.get('x-real-ip')}` : null,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          memory.users.find((user) => user.id === where.id) ?? null,
      ),
    },
    userMusicCollection: {
      count: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          memory.collections.filter((row) => matches(row, where)).length,
      ),
      findFirst: vi.fn(async (args: { where: Record<string, unknown>; select?: unknown }) =>
        // The public lookup by link (it selects the items) uses the detailed mock below.
        'shareId' in args.where && (args.select as { items?: unknown } | undefined)?.items
          ? mocks.findUnique(args)
          : (memory.collections.find((row) => matches(row, args.where)) ?? null),
      ),
      findUnique: mocks.findUnique,
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        memory.collections.filter((row) => matches(row, where)).map((row) => withItems(row)),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<CollectionRow>;
        }) => {
          mocks.collectionUpdates.push({ where, data });
          const rows = memory.collections.filter((row) => matches(row, where));
          for (const row of rows) Object.assign(row, data, { updatedAt: new Date() });
          return { count: rows.length };
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { userId_name: { userId: string; name: string } };
          create: { userId: string; name: string; kind: string };
        }) => {
          const existing = memory.collections.find((row) => matches(row, where.userId_name));
          if (existing) return existing;
          const row: CollectionRow = {
            id: `collection-${++memory.counter}`,
            folderId: null,
            shareId: null,
            sharedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          };
          memory.collections.push(row);
          return row;
        },
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            userId: string;
            name: string;
            kind: string;
            items: { create: Array<Omit<ItemRow, 'id' | 'collectionId'>> };
          };
        }) => {
          if (
            memory.collections.some((row) => row.userId === data.userId && row.name === data.name)
          )
            throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
          const row: CollectionRow = {
            id: `collection-${++memory.counter}`,
            userId: data.userId,
            name: data.name,
            kind: data.kind,
            folderId: null,
            shareId: null,
            sharedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          memory.collections.push(row);
          for (const item of data.items.create) {
            memory.items.push({ id: `item-${++memory.counter}`, collectionId: row.id, ...item });
          }
          return { id: row.id };
        },
      ),
    },
    userMusicCollectionItem: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

import { POST as collectionsPost } from '@/app/api/music/collections/route';
import { GET as sharedGet } from '@/app/api/music/shared/[shareId]/route';
import { POST as savePost } from '@/app/api/music/shared/[shareId]/save/route';
import { SharedPlaylistSchema } from '@/lib/contracts/shared-playlist';
import {
  isShareId,
  SHARED_PLAYLIST_OWNER_FALLBACK,
  sharedPlaylistOwnerName,
} from '@/lib/music/playlist-share';
import {
  generateShareId,
  getSharedPlaylistMetaDescription,
  isShareableCoverUrl,
  sharedPlaylistCovers,
  sharedPlaylistMetaDescription,
} from '@/lib/music/shared-playlists.server';
import { publicSiteUrl } from '@/lib/public-links';

const DAY = 24 * 60 * 60 * 1000;

function collectionsRequest(body: unknown) {
  return collectionsPost(
    new Request('https://solco.test/api/music/collections', {
      method: 'POST',
      headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function readShared(shareId: string, ip = '203.0.113.7') {
  return sharedGet(
    new Request(`https://solco.test/api/music/shared/${shareId}`, {
      headers: { 'x-real-ip': ip },
    }),
    { params: Promise.resolve({ shareId }) },
  );
}

function saveShared(shareId: string) {
  return savePost(
    new Request(`https://solco.test/api/music/shared/${shareId}/save`, {
      method: 'POST',
      headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ shareId }) },
  );
}

function addCollection(row: Partial<CollectionRow> & Pick<CollectionRow, 'userId' | 'name'>) {
  const collection: CollectionRow = {
    id: `collection-${++memory.counter}`,
    kind: 'playlist',
    folderId: null,
    shareId: null,
    sharedAt: null,
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    updatedAt: new Date('2026-11-01T10:00:00.000Z'),
    ...row,
  };
  memory.collections.push(collection);
  return collection;
}

function addItem(
  collectionId: string,
  item: Partial<ItemRow> & Pick<ItemRow, 'source' | 'sourceId'>,
) {
  const row: ItemRow = {
    id: `item-${++memory.counter}`,
    collectionId,
    title: null,
    creatorName: null,
    artworkUrl: null,
    sourceUrl: null,
    artistUrl: null,
    durationSeconds: null,
    createdAt: new Date(Date.now() - memory.counter * 1000),
    expiresAt: null,
    ...item,
  };
  memory.items.push(row);
  return row;
}

/** A playlist owned by "owner" with an Audius track, a fresh and an expired YouTube video. */
function seedPlaylist() {
  const playlist = addCollection({ userId: 'owner', name: 'Viaggio notturno' });
  addItem(playlist.id, {
    source: 'audius',
    sourceId: 'track-71',
    title: 'Luci basse',
    creatorName: 'Artista Audius',
    artworkUrl: 'https://audius.co/content/abc/480x480.jpg',
    sourceUrl: 'https://audius.co/artista/luci-basse',
    artistUrl: 'https://audius.co/artista',
    durationSeconds: 201,
    createdAt: new Date(Date.now() - 1_000),
  });
  addItem(playlist.id, {
    source: 'youtube',
    sourceId: 'dQw4w9WgXcQ',
    title: 'Video fresco',
    creatorName: 'Canale',
    artworkUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    createdAt: new Date(Date.now() - 2_000),
    expiresAt: new Date(Date.now() + 10 * DAY),
  });
  addItem(playlist.id, {
    source: 'youtube',
    sourceId: 'aaaaaaaaaaa',
    title: 'Video scaduto',
    creatorName: 'Canale vecchio',
    artworkUrl: 'https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg',
    sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    createdAt: new Date(Date.now() - 3_000),
    expiresAt: new Date(Date.now() - DAY),
  });
  return playlist;
}

beforeEach(() => {
  mocks.forcedRandom.length = 0;
  mocks.collectionUpdates.length = 0;
  memory.userId = 'owner';
  memory.emailVerified = true;
  memory.phoneNumberVerified = null;
  memory.sameOrigin = true;
  memory.counter = 0;
  memory.collections = [];
  memory.items = [];
  memory.users = [
    { id: 'owner', name: '  Giulia Bianchi Rossi ', email: 'giulia@example.test' },
    { id: 'friend', name: 'Marco', email: 'marco@example.test' },
  ];
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
  mocks.findUnique
    .mockReset()
    .mockImplementation(
      async ({
        where,
        select,
      }: {
        where: { shareId: string };
        select?: { items?: { take?: number } };
      }) => {
        const row = memory.collections.find(
          (collection) => collection.shareId !== null && collection.shareId === where.shareId,
        );
        return row ? withItems(row, select?.items?.take) : null;
      },
    );
});

describe('condivisione di una playlist (azioni share/unshare)', () => {
  it('crea un link solo per il proprietario ed è idempotente', async () => {
    const playlist = seedPlaylist();
    const first = await collectionsRequest({ action: 'share', collectionId: playlist.id });
    const firstBody = await first.json();
    expect(first.status, JSON.stringify(firstBody)).toBe(200);
    expect(firstBody.shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Sempre sul sito pubblico, non sull'host dell'app (NEXT_PUBLIC_APP_URL, qui solco.test).
    expect(firstBody.url).toBe(`${publicSiteUrl()}/playlist/${firstBody.shareId}`);
    expect(first.headers.get('cache-control')).toContain('no-store');
    const listed = firstBody.collections.find((item: { id: string }) => item.id === playlist.id);
    expect(listed.shareId).toBe(firstBody.shareId);
    expect(listed.sharedAt).toEqual(expect.any(String));

    const again = await collectionsRequest({ action: 'share', collectionId: playlist.id });
    expect((await again.json()).shareId).toBe(firstBody.shareId);

    memory.userId = 'friend';
    const stranger = await collectionsRequest({ action: 'share', collectionId: playlist.id });
    expect(stranger.status).toBe(404);
    const strangerUnshare = await collectionsRequest({
      action: 'unshare',
      collectionId: playlist.id,
    });
    expect(strangerUnshare.status).toBe(404);
    expect(memory.collections.find((row) => row.id === playlist.id)?.shareId).toBe(
      firstBody.shareId,
    );
  });

  it('non assegna mai un id già usato da un’altra playlist (nessun vincolo unico nel database)', async () => {
    const taken = Buffer.alloc(16, 7);
    const fresh = Buffer.alloc(16, 9);
    const other = addCollection({ userId: 'friend', name: 'Altra' });
    other.shareId = taken.toString('base64url');
    const playlist = seedPlaylist();
    mocks.forcedRandom.push(taken, fresh);
    const response = await collectionsRequest({ action: 'share', collectionId: playlist.id });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.shareId).toBe(fresh.toString('base64url'));
    expect(memory.collections.filter((row) => row.shareId === body.shareId)).toHaveLength(1);
  });

  it('non condivide mai i Preferiti', async () => {
    const favorites = addCollection({ userId: 'owner', name: 'Preferiti', kind: 'favorites' });
    const response = await collectionsRequest({ action: 'share', collectionId: favorites.id });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('not_shareable');
    expect(favorites.shareId).toBeNull();
  });

  it('smettere di condividere azzera il link e quello vecchio non risponde più', async () => {
    const playlist = seedPlaylist();
    const shared = await (
      await collectionsRequest({ action: 'share', collectionId: playlist.id })
    ).json();
    expect((await readShared(shared.shareId)).status).toBe(200);

    const unshare = await collectionsRequest({ action: 'unshare', collectionId: playlist.id });
    expect(unshare.status).toBe(200);
    expect(playlist.shareId).toBeNull();
    expect(playlist.sharedAt).toBeNull();
    expect((await readShared(shared.shareId)).status).toBe(404);

    const reshared = await (
      await collectionsRequest({ action: 'share', collectionId: playlist.id })
    ).json();
    expect(reshared.shareId).not.toBe(shared.shareId);
  });

  it('serve un indirizzo email verificato per creare un link pubblico', async () => {
    const playlist = seedPlaylist();
    memory.emailVerified = false;
    const refused = await collectionsRequest({ action: 'share', collectionId: playlist.id });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('cache-control')).toContain('no-store');
    const body = await refused.json();
    expect(body.error).toBe('email_not_verified');
    expect(body.message).toContain('verificare il tuo indirizzo email');
    expect(playlist.shareId).toBeNull();
    expect(playlist.sharedAt).toBeNull();

    // Verified: the same request creates the link.
    memory.emailVerified = true;
    const shared = await collectionsRequest({ action: 'share', collectionId: playlist.id });
    expect(shared.status).toBe(200);
    const { shareId } = await shared.json();

    // A link created earlier keeps answering, and the owner can always stop sharing it.
    memory.emailVerified = false;
    expect((await readShared(shareId)).status).toBe(200);
    const unshare = await collectionsRequest({ action: 'unshare', collectionId: playlist.id });
    expect(unshare.status).toBe(200);
    expect(playlist.shareId).toBeNull();
  });

  it('un account creato col telefono (numero verificato via SMS) può condividere', async () => {
    const playlist = seedPlaylist();
    memory.emailVerified = false; // email provvisoria, non verificabile
    memory.phoneNumberVerified = true;
    const shared = await collectionsRequest({ action: 'share', collectionId: playlist.id });
    expect(shared.status).toBe(200);

    // Numero non verificato (null/false) ed email non verificata: rifiutato come prima.
    const other = seedPlaylist();
    memory.phoneNumberVerified = false;
    const refused = await collectionsRequest({ action: 'share', collectionId: other.id });
    expect(refused.status).toBe(403);
  });

  it('richiede same-origin e accesso', async () => {
    const playlist = seedPlaylist();
    memory.sameOrigin = false;
    expect((await collectionsRequest({ action: 'share', collectionId: playlist.id })).status).toBe(
      403,
    );
    memory.sameOrigin = true;
    memory.userId = null;
    expect((await collectionsRequest({ action: 'share', collectionId: playlist.id })).status).toBe(
      401,
    );
    expect(playlist.shareId).toBeNull();
  });
});

describe('lettura pubblica di una playlist condivisa', () => {
  async function sharedPlaylist() {
    const playlist = seedPlaylist();
    playlist.shareId = generateShareId();
    playlist.sharedAt = new Date();
    return playlist;
  }

  it('valida il formato prima di qualsiasi query', async () => {
    for (const id of ['abc', 'x'.repeat(23), 'a/b+c=d'.padEnd(22, 'x'), '%27%20OR%201%3D1']) {
      const response = await readShared(id);
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('risponde senza dati privati, con il nome di battesimo e la cache pubblica', async () => {
    const playlist = await sharedPlaylist();
    const response = await readShared(playlist.shareId as string);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=300',
    );
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('vary') ?? '').not.toMatch(/cookie/i);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.catalog', 'ip:203.0.113.7');
    expect(SharedPlaylistSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({ name: 'Viaggio notturno', owner: 'Giulia', itemCount: 3 });
    expect(Object.keys(body).sort()).toEqual([
      'description',
      'itemCount',
      'items',
      'name',
      'owner',
      'updatedAt',
    ]);
    // Nessuna descrizione ancora: un null esplicito, mai i campi privati intorno.
    expect(body.description).toBeNull();
    const serialized = JSON.stringify(body);
    for (const secret of ['"userId"', 'giulia@example.test', 'Bianchi', 'Rossi', playlist.id]) {
      expect(serialized).not.toContain(secret);
    }
    // No internal row ids either (cuid timestamp + fingerprint): items are keyed by source:id.
    expect(serialized).not.toContain('"id"');
    for (const row of memory.items) expect(serialized).not.toContain(`"${row.id}"`);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'artistUrl',
          'artworkUrl',
          'creatorName',
          'durationSeconds',
          'source',
          'sourceId',
          'sourceUrl',
          'title',
        ].sort(),
      );
    }
  });

  it('omette i metadati YouTube scaduti come nella Libreria, senza scrivere nel database', async () => {
    const playlist = await sharedPlaylist();
    const body = await (await readShared(playlist.shareId as string)).json();
    const expired = body.items.find(
      (item: { sourceId: string }) => item.sourceId === 'aaaaaaaaaaa',
    );
    expect(expired).toEqual({
      source: 'youtube',
      sourceId: 'aaaaaaaaaaa',
      title: null,
      creatorName: null,
      artworkUrl: null,
      sourceUrl: null,
      artistUrl: null,
      durationSeconds: null,
    });
    const fresh = body.items.find((item: { sourceId: string }) => item.sourceId === 'dQw4w9WgXcQ');
    expect(fresh.title).toBe('Video fresco');
    expect(body.items.map((item: { sourceId: string }) => item.sourceId)).toEqual([
      'track-71',
      'dQw4w9WgXcQ',
      'aaaaaaaaaaa',
    ]);
    // The stored row keeps its values until the nightly cleanup (no write from a public read).
    expect(memory.items.find((item) => item.sourceId === 'aaaaaaaaaaa')?.title).toBe(
      'Video scaduto',
    );
  });

  it('risponde 404 per id sconosciuti, playlist non più condivise e Preferiti', async () => {
    expect((await readShared(generateShareId())).status).toBe(404);
    const playlist = await sharedPlaylist();
    playlist.sharedAt = null;
    expect((await readShared(playlist.shareId as string)).status).toBe(404);
    const favorites = addCollection({
      userId: 'owner',
      name: 'Preferiti',
      kind: 'favorites',
      shareId: generateShareId(),
      sharedAt: new Date(),
    });
    expect((await readShared(favorites.shareId as string)).status).toBe(404);
  });

  it('risponde 404 se il proprietario è stato bannato o non esiste più', async () => {
    const playlist = await sharedPlaylist();
    const owner = memory.users.find((user) => user.id === 'owner');
    if (owner) owner.banned = true;
    const banned = await readShared(playlist.shareId as string);
    expect(banned.status).toBe(404);
    expect(banned.headers.get('cache-control')).toBe('no-store');
    if (owner) owner.banned = null;
    expect((await readShared(playlist.shareId as string)).status).toBe(200);
    memory.users = memory.users.filter((user) => user.id !== 'owner');
    expect((await readShared(playlist.shareId as string)).status).toBe(404);
  });

  it('risponde 200 anche con un nome fatto di emoji o lettere "decorative"', async () => {
    for (const name of ['𝓐𝓵𝓮𝓼𝓼𝓪𝓷𝓭𝓻𝓸𝓜𝓪𝓻𝓲𝓸𝓡𝓸𝓼𝓼𝓲 Rossi', '🎸'.repeat(16), '👨‍👩‍👧‍👦'.repeat(4)]) {
      memory.collections = [];
      memory.items = [];
      memory.users = [{ id: 'owner', name, email: 'giulia@example.test' }];
      const playlist = await sharedPlaylist();
      const response = await readShared(playlist.shareId as string);
      const body = await response.json();
      expect(response.status, `${name}: ${JSON.stringify(body)}`).toBe(200);
      expect(SharedPlaylistSchema.parse(body).owner.length).toBeLessThanOrEqual(30);
      expect(name.startsWith(body.owner)).toBe(true);
    }
  });

  it('rispetta il limite di richieste del catalogo', async () => {
    const playlist = await sharedPlaylist();
    mocks.enforceRateLimit.mockResolvedValueOnce(
      Response.json({ error: 'rate_limited' }, { status: 429 }),
    );
    expect((await readShared(playlist.shareId as string)).status).toBe(429);
  });
});

describe('salvare una copia di una playlist condivisa', () => {
  function shared() {
    const playlist = seedPlaylist();
    playlist.shareId = generateShareId();
    playlist.sharedAt = new Date();
    return playlist;
  }

  it('richiede same-origin e un account', async () => {
    const playlist = shared();
    memory.sameOrigin = false;
    expect((await saveShared(playlist.shareId as string)).status).toBe(403);
    memory.sameOrigin = true;
    memory.userId = null;
    expect((await saveShared(playlist.shareId as string)).status).toBe(401);
    expect(memory.collections).toHaveLength(1);
  });

  it('copia i brani nello stesso ordine in una nuova playlist del chiamante', async () => {
    const playlist = shared();
    memory.userId = 'friend';
    const response = await saveShared(playlist.shareId as string);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('library.write', 'user:friend');
    const copy = memory.collections.find((row) => row.id === body.collectionId);
    expect(copy).toMatchObject({ userId: 'friend', name: 'Viaggio notturno', kind: 'playlist' });
    expect(copy?.shareId).toBeNull();
    const copied = memory.items
      .filter((item) => item.collectionId === body.collectionId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    expect(copied.map((item) => item.sourceId)).toEqual(['track-71', 'dQw4w9WgXcQ', 'aaaaaaaaaaa']);
    // YouTube metadata keeps its original expiry (never extended); expired metadata is not copied.
    const original = memory.items.find(
      (item) => item.collectionId === playlist.id && item.sourceId === 'dQw4w9WgXcQ',
    );
    expect(copied[1]?.expiresAt?.getTime()).toBe(original?.expiresAt?.getTime());
    expect(copied[2]).toMatchObject({ title: null, artworkUrl: null, expiresAt: null });
    // The original playlist is untouched.
    expect(memory.items.filter((item) => item.collectionId === playlist.id)).toHaveLength(3);
  });

  it('il proprietario non salva una copia della propria playlist', async () => {
    const playlist = shared();
    const response = await saveShared(playlist.shareId as string);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('own_playlist');
    expect(body.message).toBe('Questa playlist è già nella tua Libreria.');
    expect(memory.collections).toHaveLength(1);
  });

  it('rinomina la copia se il nome è già usato', async () => {
    const playlist = shared();
    addCollection({ userId: 'friend', name: 'Viaggio notturno' });
    memory.userId = 'friend';
    const body = await (await saveShared(playlist.shareId as string)).json();
    expect(body.name).toBe('Viaggio notturno (2)');
  });

  it('rispetta il limite di 100 playlist con un messaggio in italiano', async () => {
    const playlist = shared();
    for (let index = 0; index < 100; index += 1) {
      addCollection({ userId: 'friend', name: `Playlist ${index}` });
    }
    memory.userId = 'friend';
    const response = await saveShared(playlist.shareId as string);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('limit_reached');
    expect(body.message).toContain('limite di 100 playlist');
    expect(memory.collections.filter((row) => row.userId === 'friend')).toHaveLength(100);
  });

  it('non salva le playlist di un proprietario bannato', async () => {
    const playlist = shared();
    const owner = memory.users.find((user) => user.id === 'owner');
    if (owner) owner.banned = true;
    memory.userId = 'friend';
    expect((await saveShared(playlist.shareId as string)).status).toBe(404);
    expect(memory.collections.filter((row) => row.userId === 'friend')).toHaveLength(0);
  });

  it('risponde 404 se la playlist non è più condivisa o l’id non è valido', async () => {
    const playlist = shared();
    playlist.shareId = null;
    playlist.sharedAt = null;
    memory.userId = 'friend';
    expect((await saveShared(generateShareId())).status).toBe(404);
    expect((await saveShared('non-valido')).status).toBe(404);
  });
});

describe('aiuti delle playlist condivise', () => {
  it('genera id da 16 byte in base64url', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateShareId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isShareId(id)).toBe(true);
    expect(isShareId('short')).toBe(false);
    expect(isShareId(42)).toBe(false);
  });

  it('taglia il nome a 30 unità UTF-16, tra caratteri interi', () => {
    // 16 astral letters = 32 UTF-16 units: the contract (zod .max) counts units, not letters.
    const fancy = sharedPlaylistOwnerName('𝓐𝓵𝓮𝓼𝓼𝓪𝓷𝓭𝓻𝓸𝓜𝓪𝓻𝓲𝓸𝓡 Rossi');
    expect(fancy).toBe('𝓐𝓵𝓮𝓼𝓼𝓪𝓷𝓭𝓻𝓸𝓜𝓪𝓻𝓲𝓸');
    expect(fancy).toHaveLength(30);
    expect(sharedPlaylistOwnerName('🎸'.repeat(16))).toBe('🎸'.repeat(15));
    // A family emoji (11 units) or a flag (4 units) is never cut in half.
    expect(sharedPlaylistOwnerName('👨‍👩‍👧‍👦'.repeat(3))).toBe('👨‍👩‍👧‍👦'.repeat(2));
    expect(sharedPlaylistOwnerName('🇮🇹'.repeat(8))).toBe('🇮🇹'.repeat(7));
    // One "character" longer than the limit on its own: the generic label.
    expect(sharedPlaylistOwnerName(`a${'\u0301'.repeat(40)}`)).toBe(SHARED_PLAYLIST_OWNER_FALLBACK);
    for (const name of ['Ἀλέξανδρος', 'Zoë', 'José', '李小龙']) {
      expect(
        SharedPlaylistSchema.shape.owner.safeParse(sharedPlaylistOwnerName(name)).success,
      ).toBe(true);
    }
  });

  it('mostra solo la prima parola del nome, mai email o il resto del nome', () => {
    expect(sharedPlaylistOwnerName('  Giulia Bianchi ')).toBe('Giulia');
    expect(sharedPlaylistOwnerName('giulia@example.test')).toBe(SHARED_PLAYLIST_OWNER_FALLBACK);
    expect(sharedPlaylistOwnerName('')).toBe(SHARED_PLAYLIST_OWNER_FALLBACK);
    expect(sharedPlaylistOwnerName(null)).toBe(SHARED_PLAYLIST_OWNER_FALLBACK);
    expect(sharedPlaylistOwnerName('A'.repeat(40))).toHaveLength(30);
    expect(sharedPlaylistOwnerName('\u202eLuca\u0000 Verdi')).toBe('Luca');
    // Nothing visible left: the generic label, never an empty-looking name.
    expect(sharedPlaylistOwnerName('\u200d\u200c Verdi')).toBe(SHARED_PLAYLIST_OWNER_FALLBACK);
  });

  it('scarica per l’anteprima solo copertine https di Audius, mai miniature YouTube', () => {
    const cid = 'QmAbcdefghijklmnopqrstu';
    expect(isShareableCoverUrl(`https://audius.co/content/${cid}/480x480.jpg`)).toBe(true);
    expect(isShareableCoverUrl(`https://creatornode.audius.co/content/${cid}/1000x1000.webp`)).toBe(
      true,
    );
    expect(isShareableCoverUrl(`https://node.example/content/${cid}/480x480.jpg`)).toBe(true);
    // YouTube API data is kept < 30 days; social platforms keep the preview image forever.
    expect(isShareableCoverUrl('https://i.ytimg.com/vi/x/mqdefault.jpg')).toBe(false);
    expect(isShareableCoverUrl(`https://i.ytimg.com/content/${cid}/480x480.jpg`)).toBe(false);
    expect(isShareableCoverUrl(`http://audius.co/content/${cid}/480x480.jpg`)).toBe(false);
    expect(isShareableCoverUrl(`https://127.0.0.1/content/${cid}/480x480.jpg`)).toBe(false);
    expect(isShareableCoverUrl('https://evil.example/cover.jpg')).toBe(false);
    // Anche sui domini Audius serve il percorso delle copertine; mai query o frammenti.
    expect(isShareableCoverUrl('https://audius.co/qualsiasi/immagine.jpg')).toBe(false);
    expect(isShareableCoverUrl('https://audius.co/content/abc/480x480.jpg')).toBe(false);
    expect(isShareableCoverUrl(`https://audius.co/content/${cid}/480x480.jpg?x=1`)).toBe(false);
    expect(isShareableCoverUrl(`https://audius.co/content/${cid}/480x480.jpg#x`)).toBe(false);
    expect(isShareableCoverUrl(`https://audius.co/content/${cid}/480x480.jpg?`)).toBe(false);
    const audius = (name: string) => `https://audius.co/content/Qm${name.repeat(20)}/480x480.jpg`;
    expect(
      sharedPlaylistCovers([
        { source: 'audius', artworkUrl: null },
        { source: 'youtube', artworkUrl: 'https://i.ytimg.com/vi/a/mqdefault.jpg' },
        // Even an Audius-looking URL saved on a YouTube item is never drawn.
        { source: 'youtube', artworkUrl: audius('yt') },
        { source: 'song', artworkUrl: audius('song') },
        { source: 'audius', artworkUrl: audius('a') },
        { source: 'audius', artworkUrl: audius('a') },
        { source: 'audius', artworkUrl: audius('b') },
        { source: 'audius', artworkUrl: audius('c') },
        { source: 'audius', artworkUrl: audius('d') },
        { source: 'audius', artworkUrl: audius('e') },
      ]),
    ).toEqual([audius('a'), audius('b'), audius('c'), audius('d')]);
  });
});

/** Caratteri invisibili e di controllo, scritti per code point: il sorgente resta leggibile. */
const NUL = String.fromCodePoint(0x0);
const BEL = String.fromCodePoint(0x7);
const RLO = String.fromCodePoint(0x202e);
const PDF = String.fromCodePoint(0x202c);
const LRI = String.fromCodePoint(0x2066);
const PDI = String.fromCodePoint(0x2069);
const ZWSP = String.fromCodePoint(0x200b);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const ZWJ = String.fromCodePoint(0x200d);

function updateDescription(collectionId: string, description: unknown) {
  return collectionsRequest({ action: 'update_playlist', collectionId, description });
}

describe('descrizione di una playlist (azione update_playlist)', () => {
  it('salva il testo ripulito con un solo updateMany limitato a playlist e proprietario', async () => {
    const playlist = seedPlaylist();
    const response = await updateDescription(
      playlist.id,
      '  Brani lenti  \r\nper le sere d’inverno\t ',
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.collectionUpdates).toEqual([
      {
        where: { id: playlist.id, userId: 'owner', kind: 'playlist' },
        data: { description: 'Brani lenti\nper le sere d’inverno' },
      },
    ]);
    expect(playlist.description).toBe('Brani lenti\nper le sere d’inverno');
    const listed = body.collections.find((item: { id: string }) => item.id === playlist.id);
    expect(listed.description).toBe('Brani lenti\nper le sere d’inverno');
    // Anche questa azione passa dal limite di scrittura della Libreria.
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('library.write', 'user:owner');
  });

  it('toglie caratteri di controllo e override bidi e lascia al massimo una riga vuota', async () => {
    const playlist = seedPlaylist();
    const raw = `${RLO}Notte${PDF} ${LRI}fonda${PDI}${NUL}${BEL}${ZWSP}\n\n\n\n\nseconda${LINE_SEPARATOR}terza 👨${ZWJ}👩`;
    const response = await updateDescription(playlist.id, raw);
    expect(response.status).toBe(200);
    expect(playlist.description).toBe(`Notte fonda\n\nseconda\nterza 👨${ZWJ}👩`);
  });

  it('un testo vuoto o di soli spazi (e null) toglie la descrizione', async () => {
    const playlist = seedPlaylist();
    playlist.description = 'Vecchia descrizione';
    for (const empty of ['', '   \n\n  ', `${ZWSP}${RLO}`, null]) {
      playlist.description = 'Vecchia descrizione';
      const response = await updateDescription(playlist.id, empty);
      expect(response.status, JSON.stringify(empty)).toBe(200);
      expect(playlist.description).toBeNull();
      const listed = (await response.json()).collections.find(
        (item: { id: string }) => item.id === playlist.id,
      );
      expect(listed.description).toBeNull();
    }
  });

  it('oltre 300 caratteri risponde 400 con l’errore sul campo, senza scrivere', async () => {
    const playlist = seedPlaylist();
    // 300 caratteri esatti vanno bene, anche con spazi finali che vengono tolti.
    const fits = await updateDescription(playlist.id, `${'a'.repeat(300)}   `);
    expect(fits.status).toBe(200);
    expect(playlist.description).toHaveLength(300);
    mocks.collectionUpdates.length = 0;

    // 1001 caratteri grezzi: rifiutati prima della pulizia (il contratto limita anche il grezzo).
    for (const tooLong of ['a'.repeat(301), 'b'.repeat(1001)]) {
      const response = await updateDescription(playlist.id, tooLong);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        errors: { description: 'La descrizione può avere al massimo 300 caratteri.' },
      });
    }
    // Un corpo oltre 4 KB non arriva mai al contratto.
    expect((await updateDescription(playlist.id, 'c'.repeat(5000))).status).toBe(413);
    // Anche un valore del tipo sbagliato è un errore del campo (applyServerErrors lo porta sul modulo).
    const wrongType = await updateDescription(playlist.id, 42);
    expect(wrongType.status).toBe(400);
    expect(Object.keys((await wrongType.json()).errors)).toEqual(['description']);
    expect(mocks.collectionUpdates).toHaveLength(0);
    expect(playlist.description).toHaveLength(300);
  });

  it('senza il campo description o senza collectionId la richiesta è malformata', async () => {
    const playlist = seedPlaylist();
    const missing = await collectionsRequest({
      action: 'update_playlist',
      collectionId: playlist.id,
    });
    expect(missing.status).toBe(400);
    expect(Object.keys((await missing.json()).errors)).toEqual(['description']);
    const noId = await collectionsRequest({ action: 'update_playlist', description: 'Ciao' });
    expect(noId.status).toBe(400);
    expect((await noId.json()).errors).toEqual({ body: 'Controlla i dati della raccolta.' });
    expect(mocks.collectionUpdates).toHaveLength(0);
  });

  it('risponde 404 per le playlist di un altro account e per i Preferiti', async () => {
    const playlist = seedPlaylist();
    memory.userId = 'friend';
    const stranger = await updateDescription(playlist.id, 'Non è mia');
    expect(stranger.status).toBe(404);
    expect((await stranger.json()).error).toBe('not_found');
    expect(playlist.description).toBeUndefined();

    memory.userId = 'owner';
    const favorites = addCollection({ userId: 'owner', name: 'Preferiti', kind: 'favorites' });
    const refused = await updateDescription(favorites.id, 'I miei preferiti');
    expect(refused.status).toBe(404);
    expect(favorites.description).toBeUndefined();
    expect(mocks.collectionUpdates.at(-1)?.where).toEqual({
      id: favorites.id,
      userId: 'owner',
      kind: 'playlist',
    });
  });

  it('richiede same-origin e un account', async () => {
    const playlist = seedPlaylist();
    memory.sameOrigin = false;
    const crossSite = await updateDescription(playlist.id, 'Da un altro sito');
    expect(crossSite.status).toBe(403);
    memory.sameOrigin = true;
    memory.userId = null;
    expect((await updateDescription(playlist.id, 'Senza accesso')).status).toBe(401);
    expect(mocks.collectionUpdates).toHaveLength(0);
    expect(playlist.description).toBeUndefined();
  });
});

describe('descrizione nella lettura pubblica e nell’anteprima dei link', () => {
  function sharedWithDescription(description: string | null) {
    const playlist = seedPlaylist();
    playlist.shareId = generateShareId();
    playlist.sharedAt = new Date();
    playlist.description = description;
    return playlist;
  }

  it('la lettura pubblica include la descrizione come testo semplice', async () => {
    const playlist = sharedWithDescription('Per correre\n\nall’alba <b>forte</b>');
    const response = await readShared(playlist.shareId as string);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(SharedPlaylistSchema.parse(body).description).toBe(
      'Per correre\n\nall’alba <b>forte</b>',
    );
  });

  it('una risposta senza descrizione (server precedente o cache CDN) resta valida', () => {
    const old = {
      name: 'Viaggio notturno',
      owner: 'Giulia',
      itemCount: 0,
      items: [],
      updatedAt: '2026-11-10T12:00:00.000Z',
    };
    expect(SharedPlaylistSchema.parse(old).description).toBeUndefined();
    expect(SharedPlaylistSchema.parse({ ...old, description: null }).description).toBeNull();
  });

  it('l’anteprima usa la descrizione senza indirizzi web, su una riga e al massimo di 160 caratteri', async () => {
    const playlist = sharedWithDescription(
      'Ascoltala qui https://evil.example/x?y=1 oppure www.spam.example\n\nbuon viaggio',
    );
    const description = await getSharedPlaylistMetaDescription(playlist.shareId as string);
    expect(description).toBe('Ascoltala qui oppure buon viaggio');

    const long = sharedWithDescription(`${'parola '.repeat(60)}fine`);
    const clipped = await getSharedPlaylistMetaDescription(long.shareId as string);
    expect(clipped?.length).toBeLessThanOrEqual(160);
    expect(clipped?.endsWith('…')).toBe(true);
  });

  it('nessuna descrizione per l’anteprima se non c’è, la playlist non è condivisa o il proprietario non è disponibile', async () => {
    expect(await getSharedPlaylistMetaDescription('non-valido')).toBeNull();
    expect(await getSharedPlaylistMetaDescription(generateShareId())).toBeNull();
    const empty = sharedWithDescription(null);
    expect(await getSharedPlaylistMetaDescription(empty.shareId as string)).toBeNull();
    const onlyLinks = sharedWithDescription('https://evil.example www.spam.example');
    expect(await getSharedPlaylistMetaDescription(onlyLinks.shareId as string)).toBeNull();
    const notShared = sharedWithDescription('Privata');
    notShared.sharedAt = null;
    expect(await getSharedPlaylistMetaDescription(notShared.shareId as string)).toBeNull();
    const favorites = sharedWithDescription('Preferiti');
    favorites.kind = 'favorites';
    expect(await getSharedPlaylistMetaDescription(favorites.shareId as string)).toBeNull();
    memory.users = memory.users.map((user) =>
      user.id === 'owner' ? { ...user, banned: true } : user,
    );
    const banned = sharedWithDescription('Bannato');
    expect(await getSharedPlaylistMetaDescription(banned.shareId as string)).toBeNull();
  });

  it('ricorda la risposta per un minuto, poi rilegge', async () => {
    const playlist = sharedWithDescription('Prima versione');
    const shareId = playlist.shareId as string;
    const start = Date.now();
    expect(await getSharedPlaylistMetaDescription(shareId, start)).toBe('Prima versione');
    playlist.description = 'Seconda versione';
    expect(await getSharedPlaylistMetaDescription(shareId, start + 30_000)).toBe('Prima versione');
    expect(await getSharedPlaylistMetaDescription(shareId, start + 61_000)).toBe(
      'Seconda versione',
    );
  });

  it('sharedPlaylistMetaDescription ripulisce anche il testo grezzo', () => {
    expect(sharedPlaylistMetaDescription(null)).toBeNull();
    expect(sharedPlaylistMetaDescription(`${RLO}Ciao${NUL}\n\nmondo  http://x.example`)).toBe(
      'Ciao mondo',
    );
    const emoji = sharedPlaylistMetaDescription('🎸'.repeat(100)) ?? '';
    expect(emoji.length).toBeLessThanOrEqual(160);
    // Mai mezza emoji prima dei puntini.
    expect(emoji).toBe(`${'🎸'.repeat(79)}…`);
  });

  it('sharedPlaylistMetaDescription toglie anche domini nudi, email, IP e indirizzi a larghezza piena', () => {
    expect(
      sharedPlaylistMetaDescription(
        'Avviso Solco: Premium scaduto, rinnova su solco-premium.it/rinnovo o bit.ly/abc entro 24h',
      ),
    ).toBe('Avviso Solco: Premium scaduto, rinnova su o entro 24h');
    expect(sharedPlaylistMetaDescription('Scrivi a mario.rossi@evil.com subito')).toBe(
      'Scrivi a subito',
    );
    expect(sharedPlaylistMetaDescription('Server 203.0.113.5:8080/x qui')).toBe('Server qui');
    expect(sharedPlaylistMetaDescription('Vedi EVIL.COM e xn--80ak6aa92e.com?x=1 ora')).toBe(
      'Vedi e ora',
    );
    // Punto ideografico e lettere a larghezza piena: i browser li leggono come indirizzi.
    expect(sharedPlaylistMetaDescription('Vai su evil。com ora')).toBe('Vai su ora');
    expect(sharedPlaylistMetaDescription('ｈｔｔｐｓ：／／ｅｖｉｌ．ｃｏｍ')).toBeNull();
    expect(sharedPlaylistMetaDescription('ｅｖｉｌ．ｃｏｍ／ｘ e basta')).toBe('e basta');
    expect(sharedPlaylistMetaDescription('bit.ly/x')).toBeNull();
  });

  it('sharedPlaylistMetaDescription lascia il testo normale con punti e numeri', () => {
    for (const text of [
      'Vol. 2, ore 10.30, 3.5 stelle, a.k.a. il re e poi... fine.',
      'Brani lenti. Poi veloci!',
      '楽しい。音楽',
      'Versione 2.0 (2024)',
    ]) {
      expect(sharedPlaylistMetaDescription(text)).toBe(text);
    }
    // NFKC: i puntini di sospensione diventano tre punti, e il testo resta.
    expect(sharedPlaylistMetaDescription('Il re…e poi')).toBe('Il re...e poi');
  });
});
