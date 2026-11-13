// @polsia:user-owned — statistiche di ascolto personali ricavate dallo storico di riproduzione.
// Lo storico (UserPlaybackHistory) tiene UNA riga per brano con il suo conteggio ascolti, quindi le
// somme sono dirette. Nessun dato lascia il server oltre a ciò che è già nello storico dell'utente.
import 'server-only';
import type { ListeningStats } from '@/lib/contracts/listening-stats';
import { prisma } from '@/lib/db';

/** Quante righe di storico considerare al massimo (brani distinti più recenti). */
const MAX_ROWS = 2000;
const TOP_ARTISTS = 6;
const RECENT = 8;

export async function getListeningStats(userId: string): Promise<ListeningStats> {
  const rows = await prisma.userPlaybackHistory.findMany({
    where: { userId },
    select: {
      title: true,
      artistName: true,
      sourceLabel: true,
      durationSeconds: true,
      playCount: true,
      lastPlayedAt: true,
    },
    orderBy: { lastPlayedAt: 'desc' },
    take: MAX_ROWS,
  });

  let totalListens = 0;
  let totalSeconds = 0;
  const artists = new Map<string, number>();
  const sources = new Map<string, number>();

  for (const row of rows) {
    const plays = Math.max(1, row.playCount);
    totalListens += plays;
    if (row.durationSeconds && row.durationSeconds > 0) {
      totalSeconds += plays * row.durationSeconds;
    }
    const artist = row.artistName.trim();
    if (artist) artists.set(artist, (artists.get(artist) ?? 0) + plays);
    const source = row.sourceLabel.trim();
    if (source) sources.set(source, (sources.get(source) ?? 0) + plays);
  }

  const sortDesc = (entries: Iterable<[string, number]>) =>
    [...entries].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  return {
    totalListens,
    uniqueTracks: rows.length,
    uniqueArtists: artists.size,
    estimatedMinutes: Math.round(totalSeconds / 60),
    topArtists: sortDesc(artists)
      .slice(0, TOP_ARTISTS)
      .map(([name, plays]) => ({ name, plays })),
    bySource: sortDesc(sources).map(([label, plays]) => ({ label, plays })),
    recent: rows.slice(0, RECENT).map((row) => ({
      title: row.title,
      artistName: row.artistName,
      lastPlayedAt: row.lastPlayedAt.toISOString(),
    })),
  };
}
