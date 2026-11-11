// @polsia:user-owned
import type { SolcoProStatistics } from '@/lib/contracts/solco-pro';

export type SolcoProListenRecord = {
  albumId: string;
  artistName: string;
  rating: number;
  listenedOn: Date;
  context: string | null;
};

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function countBy<T>(items: T[], keyOf: (item: T) => string | null) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item)?.trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
}

export function calculateSolcoProStatistics(
  entries: SolcoProListenRecord[],
  now = new Date(),
): SolcoProStatistics {
  const months = Array.from({ length: 6 }, (_, index) => {
    const offset = index - 5;
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return { key: monthKey(month), month };
  });
  const monthCounts = new Map(months.map(({ key }) => [key, 0]));
  for (const entry of entries) {
    const key = monthKey(entry.listenedOn);
    if (monthCounts.has(key)) monthCounts.set(key, (monthCounts.get(key) ?? 0) + 1);
  }

  const artists = countBy(entries, (entry) => entry.artistName);
  const contexts = countBy(entries, (entry) => entry.context);
  const ratingTotal = entries.reduce((total, entry) => total + entry.rating, 0);
  const monthlyListens = months.map(({ key, month }) => ({
    month: new Intl.DateTimeFormat('it-IT', {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    }).format(month),
    count: monthCounts.get(key) ?? 0,
  }));

  return {
    totalListens: entries.length,
    uniqueAlbums: new Set(entries.map((entry) => entry.albumId)).size,
    uniqueArtists: new Set(entries.map((entry) => entry.artistName)).size,
    averageRating: entries.length ? Math.round((ratingTotal / entries.length) * 10) / 10 : null,
    topArtist: artists[0]?.[0] ?? null,
    topContext: contexts[0]?.[0] ?? null,
    monthlyListens,
  };
}
