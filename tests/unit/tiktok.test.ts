// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isTikTokShortLink,
  parseTikTokSoundUrl,
  parseTikTokVideoUrl,
  tiktokPlayerUrl,
} from '@/lib/music/tiktok';

describe('link TikTok', () => {
  it('accetta il link completo di un video e lo rende canonico (id come stringa)', () => {
    expect(
      parseTikTokVideoUrl(
        'https://m.tiktok.com/@artista.ufficiale/video/7234567890123456789?is_from_webapp=1',
      ),
    ).toEqual({
      handle: 'artista.ufficiale',
      videoId: '7234567890123456789',
      canonicalUrl: 'https://www.tiktok.com/@artista.ufficiale/video/7234567890123456789',
    });
  });

  it('rifiuta link brevi, altri siti e indirizzi non https', () => {
    expect(parseTikTokVideoUrl('https://vm.tiktok.com/ZMabc123/')).toBeNull();
    expect(isTikTokShortLink('https://vm.tiktok.com/ZMabc123/')).toBe(true);
    expect(
      parseTikTokVideoUrl('https://tiktok.com.evil.test/@a/video/7234567890123456789'),
    ).toBeNull();
    expect(parseTikTokVideoUrl('http://www.tiktok.com/@ab/video/7234567890123456789')).toBeNull();
  });

  it('pulisce il link del suono e costruisce il player ufficiale v1', () => {
    expect(
      parseTikTokSoundUrl(
        'https://www.tiktok.com/music/Brano-Finto-7012345678901234567?refer=embed',
      ),
    ).toBe('https://www.tiktok.com/music/Brano-Finto-7012345678901234567');
    const player = new URL(tiktokPlayerUrl('7234567890123456789', true));
    expect(player.origin + player.pathname).toBe(
      'https://www.tiktok.com/player/v1/7234567890123456789',
    );
    expect(player.searchParams.get('autoplay')).toBe('1');
    expect(player.searchParams.get('music_info')).toBe('1');
    expect(player.searchParams.get('muted')).toBeNull();
  });
});

const mocks = vi.hoisted(() => ({
  access: { allowed: true, user: { id: 'admin-1' } } as
    | { allowed: true; user: { id: string } }
    | { allowed: false; response: Response },
  create: vi.fn(),
  findUnique: vi.fn(async () => null),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => true }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: async () => null }));
vi.mock('@/lib/music/rights-admin.server', () => ({
  musicRightsPrivateHeaders: { 'Cache-Control': 'private, no-store' },
  requireVerifiedMusicRightsAdmin: async () => mocks.access,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    tikTokClip: {
      create: mocks.create,
      findUnique: mocks.findUnique,
      findMany: async () => [],
      deleteMany: async () => ({}),
    },
  },
}));

import { POST } from '@/app/api/admin/tiktok/route';

const post = (body: unknown) =>
  POST(
    new Request('https://solco.test/api/admin/tiktok', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('route admin dei video TikTok', () => {
  beforeEach(() => {
    mocks.access = { allowed: true, user: { id: 'admin-1' } };
    mocks.create.mockReset().mockImplementation(async ({ data }) => ({ id: 'c1', ...data }));
  });

  it('salva il link canonico senza parametri di tracciamento', async () => {
    const response = await post({
      url: 'https://www.tiktok.com/@artista/video/7234567890123456789?_r=1&share=abc',
      genreSlug: 'techno',
    });
    expect(response.status).toBe(201);
    expect(mocks.create.mock.calls[0]?.[0].data).toMatchObject({
      videoId: '7234567890123456789',
      canonicalUrl: 'https://www.tiktok.com/@artista/video/7234567890123456789',
      genreSlug: 'techno',
      createdById: 'admin-1',
    });
  });

  it('rifiuta non amministratori, link brevi e generi inesistenti', async () => {
    expect((await post({ url: 'https://vm.tiktok.com/ZMabc/' })).status).toBe(400);
    expect(
      (
        await post({
          url: 'https://www.tiktok.com/@a1/video/7234567890123456789',
          genreSlug: 'boh',
        })
      ).status,
    ).toBe(400);
    mocks.access = { allowed: false, response: Response.json({}, { status: 403 }) };
    expect(
      (await post({ url: 'https://www.tiktok.com/@a1/video/7234567890123456789' })).status,
    ).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
