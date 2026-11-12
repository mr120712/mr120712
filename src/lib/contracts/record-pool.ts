// @polsia:user-owned — contratto del Record Pool: brani royalty-free scaricabili (Audius OML).
import { z } from 'zod';
import { AudiusTrackSearchSchema } from '@/lib/contracts/music';

export const RecordPoolResponseSchema = z.object({
  outcome: z.enum(['results', 'no_results', 'unavailable', 'inactive']),
  /** Slug del genere selezionato, o null per "Tutti". */
  genre: z.string().nullable(),
  tracks: z.array(AudiusTrackSearchSchema),
});
export type RecordPoolResponse = z.infer<typeof RecordPoolResponseSchema>;
