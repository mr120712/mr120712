// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requirePro: vi.fn(),
  sameOrigin: vi.fn(),
  preferenceFindUnique: vi.fn(),
  preferenceUpsert: vi.fn(),
  listeningFindMany: vi.fn(),
  listeningFindFirst: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/solco-pro-entitlement', () => ({
  requireSolcoPro: mocks.requirePro,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    solcoProPreference: {
      findUnique: mocks.preferenceFindUnique,
      upsert: mocks.preferenceUpsert,
    },
    listeningEntry: {
      findMany: mocks.listeningFindMany,
      findFirst: mocks.listeningFindFirst,
    },
  },
}));

import { GET as getOverview, PATCH as updateOverview } from '@/app/api/solco-pro/overview/route';
import { GET as getCard } from '@/app/api/solco-pro/card/route';
import { buildSolcoListeningCardSvg } from '@/lib/business/solco-pro-card';
import { calculateSolcoProStatistics } from '@/lib/business/solco-pro-statistics';
import type { SolcoProCard } from '@/lib/contracts/solco-pro';

const userA = { id: 'user-a', email: 'a@example.test' };
const userB = { id: 'user-b', email: 'b@example.test' };
const listeningRows = [
  {
    albumId: 'album-1',
    artistName: 'Artista A',
    rating: 4.5,
    listenedOn: new Date('2026-11-02T12:00:00.000Z'),
    context: 'casa',
  },
  {
    albumId: 'album-1',
    artistName: 'Artista A',
    rating: 3.5,
    listenedOn: new Date('2026-10-02T12:00:00.000Z'),
    context: 'casa',
  },
  {
    albumId: 'album-2',
    artistName: 'Artista B',
    rating: 5,
    listenedOn: new Date('2026-08-02T12:00:00.000Z'),
    context: null,
  },
];

function request(path: string, init?: RequestInit) {
  return new Request(`https://solco.test${path}`, init);
}

describe('vantaggi Solco Pro', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAuth.mockResolvedValue(userA);
    mocks.requirePro.mockImplementation(async () => ({
      allowed: true,
      user: await mocks.requireAuth(),
      entitlement: {},
    }));
    mocks.sameOrigin.mockReturnValue(true);
    mocks.preferenceFindUnique.mockResolvedValue({ theme: 'blue-hour' });
    mocks.preferenceUpsert.mockImplementation(async (args: { create: { theme: string } }) => ({
      theme: args.create.theme,
    }));
    mocks.listeningFindMany.mockResolvedValue(listeningRows);
    mocks.listeningFindFirst.mockResolvedValue({
      albumName: 'Album scelto',
      artistName: 'Artista scelto',
      listenedOn: new Date('2026-11-02T12:00:00.000Z'),
      rating: 4.5,
      note: 'Una nota personale.',
    });
  });

  it('calcola statistiche dai record ricevuti e non da valori dimostrativi', () => {
    const stats = calculateSolcoProStatistics(listeningRows, new Date('2026-11-08T12:00:00.000Z'));
    expect(stats).toMatchObject({
      totalListens: 3,
      uniqueAlbums: 2,
      uniqueArtists: 2,
      averageRating: 4.3,
      topArtist: 'Artista A',
      topContext: 'casa',
    });
    expect(stats.monthlyListens.map((month) => month.count)).toEqual([0, 0, 1, 0, 1, 1]);
  });

  it('genera una card SVG dai dati dell’ascolto scelto senza logo Solco', () => {
    const card: SolcoProCard = {
      listening: {
        albumName: 'Album <Uno>',
        artistName: 'Artista & Co.',
        listenedOn: '2026-11-02',
        rating: 4.5,
        note: 'Una nota personale.',
      },
    };
    const svg = buildSolcoListeningCardSvg(card);
    expect(svg).toContain('Album &lt;Uno&gt;');
    expect(svg).toContain('Artista &amp; Co.');
    expect(svg).toContain('Una nota personale.');
    expect(svg).toContain('2026-11-02');
    expect(svg).not.toContain('Solco');
  });

  it('limita statistiche, preferenze e card all’account autenticato e attivo', async () => {
    const overview = await getOverview(request('/api/solco-pro/overview'));
    expect(overview.status).toBe(200);
    expect(mocks.listeningFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: userA.id },
    }));
    expect(mocks.preferenceFindUnique).toHaveBeenCalledWith({ where: { userId: userA.id } });

    const patch = await updateOverview(request('/api/solco-pro/overview', {
      method: 'PATCH',
      headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'amber' }),
    }));
    expect(patch.status).toBe(200);
    expect(mocks.preferenceUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: userA.id },
      update: { theme: 'amber' },
      create: { userId: userA.id, theme: 'amber' },
    }));

    const card = await getCard(request('/api/solco-pro/card?entry_id=entry-a'));
    expect(card.status).toBe(200);
    expect(await card.json()).toEqual({
      listening: {
        albumName: 'Album scelto',
        artistName: 'Artista scelto',
        listenedOn: '2026-11-02',
        rating: 4.5,
        note: 'Una nota personale.',
      },
    });
    expect(mocks.listeningFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'entry-a', userId: userA.id },
    }));

    mocks.requireAuth.mockResolvedValue(userB);
    mocks.listeningFindFirst.mockResolvedValue(null);
    const otherAccountCard = await getCard(request('/api/solco-pro/card?entry_id=entry-a'));
    expect(otherAccountCard.status).toBe(404);
    expect(mocks.listeningFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'entry-a', userId: userB.id },
    }));
  });

  it('restituisce statistiche vuote per un altro account, senza condividere i record', async () => {
    mocks.requireAuth.mockResolvedValue(userB);
    mocks.listeningFindMany.mockImplementation(async (args: { where: { userId: string } }) =>
      args.where.userId === userA.id ? listeningRows : [],
    );

    const response = await getOverview(request('/api/solco-pro/overview'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.statistics.totalListens).toBe(0);
    expect(mocks.listeningFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: userB.id },
    }));
  });

  it('nega Free e stato non verificabile prima di leggere dati Pro', async () => {
    mocks.requirePro.mockResolvedValue({
      allowed: false,
      response: Response.json({ error: 'pro_required' }, { status: 403 }),
    });
    const free = await getOverview(request('/api/solco-pro/overview'));
    expect(free.status).toBe(403);
    expect(mocks.listeningFindMany).not.toHaveBeenCalled();
    expect(mocks.preferenceFindUnique).not.toHaveBeenCalled();
    const freeCard = await getCard(request('/api/solco-pro/card?entry_id=entry-a'));
    expect(freeCard.status).toBe(403);
    expect(mocks.listeningFindFirst).not.toHaveBeenCalled();
    const freeThemeUpdate = await updateOverview(request('/api/solco-pro/overview', {
      method: 'PATCH',
      headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'amber' }),
    }));
    expect(freeThemeUpdate.status).toBe(403);
    expect(mocks.preferenceUpsert).not.toHaveBeenCalled();

    mocks.requirePro.mockResolvedValue({
      allowed: false,
      response: Response.json({ error: 'pro_entitlement_unavailable' }, { status: 503 }),
    });
    const access = await getOverview(request('/api/solco-pro/overview'));
    expect(access.status).toBe(503);
    expect(mocks.listeningFindMany).not.toHaveBeenCalled();
  });

  it('rifiuta l’account anonimo prima di leggere dati Pro', async () => {
    mocks.requirePro.mockResolvedValue({
      allowed: false,
      response: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const response = await getOverview(request('/api/solco-pro/overview'));
    expect(response.status).toBe(401);
    expect(mocks.listeningFindMany).not.toHaveBeenCalled();
  });
});
