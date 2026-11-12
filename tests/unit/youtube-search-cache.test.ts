// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createYouTubeSearchCache } from '@/lib/music/youtube-search-cache.server';

describe('cache volatile della ricerca YouTube', () => {
  it('deduplica query equivalenti e rinnova solo dopo la scadenza', async () => {
    let now = 1_000;
    const cache = createYouTubeSearchCache({ ttlMs: 120_000, maxEntries: 4, now: () => now });
    const load = vi.fn(async () => ({ outcome: 'results', items: ['metadata'] }));

    const first = await cache.get('  Björk  ', load);
    const same = await cache.get('björk', load);
    expect(first).toEqual(same);
    expect(load).toHaveBeenCalledOnce();

    now += 120_001;
    await cache.get('björk', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('condivide una richiesta concorrente e non conserva quota/esiti API non disponibili', async () => {
    const cache = createYouTubeSearchCache({ ttlMs: 60_000 });
    let finish: ((value: { outcome: string }) => void) | undefined;
    const pending = new Promise<{ outcome: string }>((resolve) => {
      finish = resolve;
    });
    const load = vi.fn(() => pending);
    const first = cache.get('ambient', load);
    const second = cache.get('AMBIENT', load);
    expect(load).toHaveBeenCalledOnce();
    finish?.({ outcome: 'unavailable' });
    await Promise.all([first, second]);
    await cache.get('ambient', async () => ({ outcome: 'no_results' }));
    expect(cache.size()).toBe(1);
  });

  it('elimina le chiavi più vecchie quando raggiunge il limite di memoria', async () => {
    const cache = createYouTubeSearchCache({ ttlMs: 60_000, maxEntries: 2 });
    await cache.get('uno', async () => ({ outcome: 'results' }));
    await cache.get('due', async () => ({ outcome: 'results' }));
    await cache.get('tre', async () => ({ outcome: 'results' }));
    expect(cache.size()).toBe(2);
  });

  it('usa la stessa forma canonica della cache nel database', async () => {
    const cache = createYouTubeSearchCache({ ttlMs: 60_000 });
    const load = vi.fn(async () => ({ outcome: 'results' }));
    await cache.get('Perché', load);
    await cache.get('perche!', load);
    expect(load).toHaveBeenCalledOnce();
  });

  it('chi si unisce a una ricerca in corso non riceve il limite personale di un altro', async () => {
    type Result = { who: string; personal: boolean };
    const cache = createYouTubeSearchCache<Result>({
      ttlMs: 60_000,
      cacheable: (value) => !value.personal,
    });
    let finish: ((value: Result) => void) | undefined;
    const pending = new Promise<Result>((resolve) => {
      finish = resolve;
    });
    // Listener A is over their daily share; B asks the same thing while A's search is running.
    const first = cache.get('mina', () => pending);
    const loadB = vi.fn(async (): Promise<Result> => ({ who: 'b', personal: false }));
    const second = cache.get('Mina', loadB);
    finish?.({ who: 'a', personal: true });
    await expect(first).resolves.toEqual({ who: 'a', personal: true });
    await expect(second).resolves.toEqual({ who: 'b', personal: false });
    expect(loadB).toHaveBeenCalledOnce();

    // A result valid for everyone is still shared with whoever joins.
    const shared = vi.fn(async (): Promise<Result> => ({ who: 'c', personal: false }));
    const [one, two] = await Promise.all([cache.get('vasco', shared), cache.get('vasco', loadB)]);
    expect(one).toEqual(two);
    expect(shared).toHaveBeenCalledOnce();
  });

  it('non conserva ciò che non è riutilizzabile per tutti (risultati salvati)', async () => {
    const cache = createYouTubeSearchCache<{ outcome: string; stale: boolean }>({
      ttlMs: 60_000,
      cacheable: (value) => !value.stale,
    });
    const load = vi.fn(async () => ({ outcome: 'results', stale: true }));
    await cache.get('alfa', load);
    await cache.get('alfa', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
