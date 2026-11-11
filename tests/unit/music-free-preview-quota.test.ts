// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const usageRows = vi.hoisted(() => new Map<string, { userId: string; consumedMilliseconds: number }>());

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    musicFreePreviewUsage: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        usageRows.get(where.userId) ?? null,
      upsert: async ({
        where,
        create,
      }: {
        where: { userId: string };
        create: { userId: string; consumedMilliseconds: number };
      }) => {
        const existing = usageRows.get(where.userId);
        if (existing) return existing;
        usageRows.set(create.userId, create);
        return create;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; consumedMilliseconds: number };
        data: { consumedMilliseconds: { increment: number } };
      }) => {
        const existing = usageRows.get(where.userId);
        if (!existing || existing.consumedMilliseconds !== where.consumedMilliseconds) {
          return { count: 0 };
        }
        usageRows.set(where.userId, {
          ...existing,
          consumedMilliseconds: existing.consumedMilliseconds + data.consumedMilliseconds.increment,
        });
        return { count: 1 };
      },
    },
  },
}));

import {
  consumeFreePreviewQuota,
  readFreePreviewQuota,
  serializeFreePreviewQuota,
} from '@/lib/music/free-preview-quota.server';

beforeEach(() => usageRows.clear());

describe('budget anteprime Free condiviso per account', () => {
  it('somma caricamenti da sito e app e si ferma esattamente a 40 secondi', async () => {
    expect(await consumeFreePreviewQuota('fan-1', 25)).toBe(true);
    expect(await consumeFreePreviewQuota('fan-1', 15)).toBe(true);
    expect(await consumeFreePreviewQuota('fan-1', 1)).toBe(false);

    expect(serializeFreePreviewQuota(await readFreePreviewQuota('fan-1'))).toEqual({
      usedSeconds: 40,
      limitSeconds: 40,
      remainingSeconds: 0,
    });
  });

  it('addebita ogni richiesta ripetuta e non azzera il budget cambiando brano', async () => {
    expect(await consumeFreePreviewQuota('fan-2', 18)).toBe(true);
    expect(await consumeFreePreviewQuota('fan-2', 18)).toBe(true);
    expect(await consumeFreePreviewQuota('fan-2', 5)).toBe(false);
    expect((await readFreePreviewQuota('fan-2')).usedMilliseconds).toBe(36_000);
  });

  it('mantiene il residuo per una singola identità e isola gli account diversi', async () => {
    expect(await consumeFreePreviewQuota('fan-3', 31.275)).toBe(true);
    expect(await readFreePreviewQuota('fan-3')).toMatchObject({
      usedMilliseconds: 31_275,
      remainingMilliseconds: 8_725,
    });
    expect(await consumeFreePreviewQuota('fan-4', 40)).toBe(true);
    expect((await readFreePreviewQuota('fan-3')).remainingMilliseconds).toBe(8_725);
  });

  it('rifiuta durate non valide o oltre il limite della singola risorsa', async () => {
    expect(await consumeFreePreviewQuota('fan-5', 0)).toBe(false);
    expect(await consumeFreePreviewQuota('fan-5', 40.01)).toBe(false);
    expect((await readFreePreviewQuota('fan-5')).usedMilliseconds).toBe(0);
  });

  it('non supera 40 secondi con richieste concorrenti', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeFreePreviewQuota('fan-6', 5)),
    );

    expect(results.filter(Boolean)).toHaveLength(8);
    expect((await readFreePreviewQuota('fan-6')).usedMilliseconds).toBe(40_000);
  });
});
