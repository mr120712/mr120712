// @polsia:user-owned — contratto condiviso delle statistiche di ascolto personali, ricavate dallo
// storico di riproduzione dell'utente (UserPlaybackHistory).
import { z } from 'zod';

export const ListeningStatsSchema = z.object({
  /** Somma dei conteggi di ascolto di tutti i brani nello storico. */
  totalListens: z.number().int().nonnegative(),
  /** Brani distinti ascoltati. */
  uniqueTracks: z.number().int().nonnegative(),
  /** Artisti distinti. */
  uniqueArtists: z.number().int().nonnegative(),
  /** Minuti ascoltati stimati (conteggio × durata nota del brano). */
  estimatedMinutes: z.number().int().nonnegative(),
  /** Artisti più ascoltati (per numero di ascolti), dal più alto. */
  topArtists: z.array(z.object({ name: z.string().min(1), plays: z.number().int().positive() })),
  /** Ripartizione degli ascolti per fonte (Audius, YouTube, Radio, Podcast…). */
  bySource: z.array(z.object({ label: z.string().min(1), plays: z.number().int().positive() })),
  /** Ultimi brani riprodotti. */
  recent: z.array(
    z.object({
      title: z.string().min(1),
      artistName: z.string().min(1),
      lastPlayedAt: z.string().datetime(),
    }),
  ),
});
export type ListeningStats = z.infer<typeof ListeningStatsSchema>;

export const ListeningStatsResponseSchema = z.object({ stats: ListeningStatsSchema });
export type ListeningStatsResponse = z.infer<typeof ListeningStatsResponseSchema>;
