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
});
