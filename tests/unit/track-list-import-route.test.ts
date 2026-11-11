// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { id: 'u1', email: 'a@example.test' } as { id: string; email: string } | null,
  limited: vi.fn(async () => null as Response | null),
  create: vi.fn(),
  findFirst: vi.fn(async () => null),
  count: vi.fn(async () => 0),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => true }));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => {
    if (!mocks.user) throw Response.json({ error: 'unauthorized' }, { status: 401 });
    return mocks.user;
  },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.limited }));
vi.mock('@/lib/music/collections.server', () => ({
  isFavoritesName: (n: string) => n === 'Preferiti',
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    userMusicCollection: { findFirst: mocks.findFirst, create: mocks.create, count: mocks.count },
  },
}));

import { POST } from '@/app/api/music/import/track-list/route';

const post = (body: unknown) =>
  POST(
    new Request('https://solco.test/api/music/import/track-list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  mocks.user = { id: 'u1', email: 'a@example.test' };
  mocks.limited.mockReset().mockResolvedValue(null);
  mocks.create.mockReset().mockResolvedValue({ id: 'c1' });
});

describe('route /api/music/import/track-list', () => {
  it('crea una playlist di brani da cercare, nell’ordine dell’elenco', async () => {
    const response = await post({
      text: 'Band Finta - Strada Nuova\nGruppo Inventato - Luce',
      name: 'Estate',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      collectionId: 'c1',
      name: 'Estate',
      imported: 2,
      skipped: 0,
      truncated: 0,
      format: 'lines',
    });
    const data = mocks.create.mock.calls[0]?.[0].data;
    const items = data.items.create;
    expect(items.map((i: { source: string }) => i.source)).toEqual(['song', 'song']);
    expect(items[0].sourceId).toMatch(/^[a-f0-9]{32}$/);
    expect(items[0].createdAt.getTime()).toBeGreaterThan(items[1].createdAt.getTime());
    expect(data).toMatchObject({ userId: 'u1', kind: 'playlist' });
  });

  it('spiega le colonne attese e blocca le librerie piene', async () => {
    const table = await post({ text: 'Album,Anno\nUno,1999\nDue,2001' });
    expect(table.status).toBe(400);
    expect((await table.json()).errors.text).toContain('colonna con il titolo');
    mocks.count.mockResolvedValueOnce(100);
    expect((await post({ text: 'A - B' })).status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rifiuta elenchi vuoti, ospiti e richieste oltre il limite', async () => {
    expect((await post({ text: '   \n https://example.com ' })).status).toBe(400);
    mocks.limited.mockResolvedValueOnce(Response.json({}, { status: 429 }));
    expect((await post({ text: 'A - B' })).status).toBe(429);
    mocks.user = null;
    expect((await post({ text: 'A - B' })).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
