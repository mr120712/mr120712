// @polsia:user-owned — contratti per la risoluzione "brano importato -> versione Audius scaricabile".
import { z } from 'zod';

/** Numero massimo di brani per richiesta (il resto si richiede in un'altra chiamata). */
export const DOWNLOADABLE_SOURCE_MAX = 25;

export const DownloadableSongSchema = z.object({
  /** Id dell'elemento nella playlist, per riaccoppiare la risposta. */
  id: z.string().min(1).max(191),
  title: z.string().trim().min(1).max(400),
  artist: z.string().trim().max(300).nullable().optional(),
});

export const DownloadableSourceRequestSchema = z
  .object({
    songs: z.array(DownloadableSongSchema).min(1).max(DOWNLOADABLE_SOURCE_MAX),
  })
  .strict();
export type DownloadableSourceRequest = z.infer<typeof DownloadableSourceRequestSchema>;

export const DownloadableSourceResultSchema = z.object({
  id: z.string(),
  /** Id della traccia Audius scaricabile, oppure null = nessuna versione scaricabile trovata. */
  audiusTrackId: z.string().min(1).nullable(),
});

export const DownloadableSourceResponseSchema = z.object({
  results: z.array(DownloadableSourceResultSchema),
});
export type DownloadableSourceResponse = z.infer<typeof DownloadableSourceResponseSchema>;
