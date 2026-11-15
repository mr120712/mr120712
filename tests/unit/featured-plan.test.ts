// @polsia:user-owned — piano degli elenchi dei brani DICHIARATI in evidenza: Premium tutti, Free i 30
// più recenti con il totale; sotto il tetto Free nessun controllo del Premium (nessuna query in più);
// se il controllo dice Free (anche quando non risponde: fail closed) vale il tetto.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: vi.fn() }));

import {
  FEATURED_FREE_TRACK_LIMIT,
  featuredTracksForPlan,
  isFeaturedListLimited,
} from '@/lib/music/featured-plan';
import { featuredTracksForAccount } from '@/lib/music/featured-plan.server';

const list = (count: number) => Array.from({ length: count }, (_, index) => `brano-${index + 1}`);

describe('featuredTracksForPlan', () => {
  it('Free: i primi 30 (i più recenti) e il totale; Premium: tutti', () => {
    expect(FEATURED_FREE_TRACK_LIMIT).toBe(30);
    const free = featuredTracksForPlan(list(45), false);
    expect(free.tracks).toEqual(list(30));
    expect(free.total).toBe(45);
    const premium = featuredTracksForPlan(list(45), true);
    expect(premium.tracks).toEqual(list(45));
    expect(premium.total).toBe(45);
  });

  it('entro il tetto Free nessun taglio', () => {
    expect(featuredTracksForPlan(list(30), false)).toEqual({ tracks: list(30), total: 30 });
    expect(featuredTracksForPlan([], false)).toEqual({ tracks: [], total: 0 });
  });

  it('elenco tagliato solo se il totale supera i brani inviati', () => {
    expect(isFeaturedListLimited(30, 45)).toBe(true);
    expect(isFeaturedListLimited(30, 30)).toBe(false);
    expect(isFeaturedListLimited(12, undefined)).toBe(false);
  });
});

describe('featuredTracksForAccount', () => {
  it('fino a 30 brani: tutti, senza controllare il Premium', async () => {
    const isPremium = vi.fn(async () => false);
    expect(await featuredTracksForAccount(list(30), 'user-1', isPremium)).toEqual({
      tracks: list(30),
      total: 30,
    });
    expect(isPremium).not.toHaveBeenCalled();
  });

  it('oltre 30: Free (o controllo non disponibile) 30 brani, Premium tutti', async () => {
    const free = await featuredTracksForAccount(list(31), 'user-free', async () => false);
    expect(free).toEqual({ tracks: list(30), total: 31 });
    const isPremium = vi.fn(async () => true);
    const premium = await featuredTracksForAccount(list(31), 'user-pro', isPremium);
    expect(premium).toEqual({ tracks: list(31), total: 31 });
    expect(isPremium).toHaveBeenCalledWith('user-pro');
  });
});
