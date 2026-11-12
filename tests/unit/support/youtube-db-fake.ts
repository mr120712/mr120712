// @polsia:user-owned — finto database in memoria per i test della quota YouTube: contatori
// giornalieri (YouTubeQuotaUsage), vecchi contatori dei limiti (ActionRateLimit) e ricerche
// salvate (YouTubeSearchCache). updateMany applica il tetto come l'UPDATE … WHERE del database.
import { vi } from 'vitest';

export type FakeSearchRow = { key: string; payload: unknown; createdAt: Date; expiresAt: Date };
export type FakeLegacyRow = { action: string; identityHash: string; timestamps: unknown };

type CountFilter = { lte?: number; gte?: number; lt?: number };
type UsageWhere = {
  day: string;
  bucket: string;
  count?: CountFilter;
  /** A date: equal to it; { lte }: at or before it. */
  updatedAt?: Date | { lte?: Date };
};
type SearchWhere = { key: string; createdAt?: Date; expiresAt?: { lte?: Date } };
type UsageData = { count?: { increment?: number; decrement?: number }; updatedAt?: Date };

function matchesTime(value: Date, filter: Date | { lte?: Date } | undefined) {
  if (!filter) return true;
  if (filter instanceof Date) return value.getTime() === filter.getTime();
  return filter.lte === undefined || value <= filter.lte;
}

function matchesSearch(row: FakeSearchRow, where: SearchWhere) {
  if (row.key !== where.key) return false;
  if (where.createdAt && row.createdAt.getTime() !== where.createdAt.getTime()) return false;
  return matchesTime(row.expiresAt, where.expiresAt);
}

function matchesCount(value: number, filter: CountFilter | undefined) {
  if (!filter) return true;
  if (filter.lte !== undefined && value > filter.lte) return false;
  if (filter.lt !== undefined && value >= filter.lt) return false;
  if (filter.gte !== undefined && value < filter.gte) return false;
  return true;
}

export function createYouTubeDbFake(
  options: { legacy?: FakeLegacyRow[]; searches?: FakeSearchRow[] } = {},
) {
  const usage = new Map<string, number>();
  // When each counter row was last written (rows set directly in a test count as written now).
  const updated = new Map<string, Date>();
  const updatedAt = (key: string) => updated.get(key) ?? new Date();
  const legacy = [...(options.legacy ?? [])];
  const searches = new Map<string, FakeSearchRow>(
    (options.searches ?? []).map((row) => [row.key, row]),
  );
  const usageKey = (day: string, bucket: string) => `${day}|${bucket}`;

  return {
    usage,
    updated,
    legacy,
    searches,
    reset() {
      usage.clear();
      updated.clear();
      legacy.length = 0;
      searches.clear();
    },
    youTubeQuotaUsage: {
      findMany: vi.fn(async ({ where }: { where: { day: string } }) =>
        [...usage]
          .filter(([key]) => key.startsWith(`${where.day}|`))
          .map(([key, count]) => ({
            day: where.day,
            bucket: key.slice(where.day.length + 1),
            count,
            updatedAt: updatedAt(key),
          })),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { day_bucket: { day: string; bucket: string } } }) => {
          const count = usage.get(usageKey(where.day_bucket.day, where.day_bucket.bucket));
          return count === undefined ? null : { count };
        },
      ),
      updateMany: vi.fn(async ({ where, data }: { where: UsageWhere; data: UsageData }) => {
        const key = usageKey(where.day, where.bucket);
        const current = usage.get(key);
        if (current === undefined || !matchesCount(current, where.count)) return { count: 0 };
        if (!matchesTime(updatedAt(key), where.updatedAt)) return { count: 0 };
        usage.set(key, current + (data.count?.increment ?? 0) - (data.count?.decrement ?? 0));
        if (data.updatedAt) updated.set(key, data.updatedAt);
        return { count: 1 };
      }),
      createMany: vi.fn(
        async ({
          data,
        }: {
          data: Array<{ day: string; bucket: string; count?: number; updatedAt?: Date }>;
        }) => {
          let created = 0;
          for (const row of data) {
            const key = usageKey(row.day, row.bucket);
            if (usage.has(key)) continue;
            usage.set(key, row.count ?? 0);
            if (row.updatedAt) updated.set(key, row.updatedAt);
            created += 1;
          }
          return { count: created };
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { day_bucket: { day: string; bucket: string } };
          create: { count?: number; updatedAt?: Date };
          update: UsageData;
        }) => {
          const key = usageKey(where.day_bucket.day, where.day_bucket.bucket);
          const current = usage.get(key);
          if (current === undefined) {
            usage.set(key, create.count ?? 0);
            updated.set(key, create.updatedAt ?? new Date());
          } else {
            usage.set(key, current + (update.count?.increment ?? 0));
            updated.set(key, update.updatedAt ?? new Date());
          }
          return { count: usage.get(key) };
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: Partial<UsageWhere> & object }) => {
        // Only "one bucket of one day" is applied; other filters (the daily cleanup) count 0.
        if (!where.day || !where.bucket) return { count: 0 };
        const key = usageKey(where.day, where.bucket);
        if (!usage.has(key)) return { count: 0 };
        if (!matchesTime(updatedAt(key), where.updatedAt)) return { count: 0 };
        usage.delete(key);
        updated.delete(key);
        return { count: 1 };
      }),
    },
    actionRateLimit: {
      findMany: vi.fn(
        async ({ where }: { where: { action: string; identityHash: { in: string[] } } }) =>
          legacy.filter(
            (row) =>
              row.action === where.action && where.identityHash.in.includes(row.identityHash),
          ),
      ),
    },
    youTubeSearchCache: {
      findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in.flatMap((key) => {
          const row = searches.get(key);
          return row ? [row] : [];
        }),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { key: string } }) => searches.get(where.key) ?? null,
      ),
      findFirst: vi.fn(async () => {
        const rows = [...searches.values()].sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        );
        return rows[0] ? { createdAt: rows[0].createdAt } : null;
      }),
      upsert: vi.fn(
        async ({ where, create }: { where: { key: string }; create: FakeSearchRow }) => {
          searches.set(where.key, create);
          return create;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { key: string }; data: Partial<FakeSearchRow> }) => {
          const row = searches.get(where.key);
          if (!row) throw new Error('missing row');
          const updated = { ...row, ...data };
          searches.set(where.key, updated);
          return updated;
        },
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: SearchWhere; data: Partial<FakeSearchRow> }) => {
          const row = searches.get(where.key);
          if (!row || !matchesSearch(row, where)) return { count: 0 };
          searches.set(where.key, { ...row, ...data });
          return { count: 1 };
        },
      ),
      createMany: vi.fn(async ({ data }: { data: FakeSearchRow[] }) => {
        let created = 0;
        for (const row of data) {
          if (searches.has(row.key)) continue;
          searches.set(row.key, row);
          created += 1;
        }
        return { count: created };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { createdAt: { lt: Date } } }) => {
        let count = 0;
        for (const [key, row] of searches) {
          if (row.createdAt < where.createdAt.lt) {
            searches.delete(key);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
}

export type YouTubeDbFake = ReturnType<typeof createYouTubeDbFake>;

/**
 * One instance per test file, returned by `vi.mock('@/lib/db', …)` and imported by the test
 * itself (tests may not import '@/lib/db' directly).
 */
export const sharedYouTubeDbFake = createYouTubeDbFake();
