// @polsia:user-owned — contratto condiviso (client + route handler) per i "brani in evidenza" della
// Home: file audio che l'amministratore mette DIRETTAMENTE nello store Vercel Blob (dal pannello),
// elencati e riprodotti in Home. Non passano dal flusso di upload degli utenti (/pubblica).
import { z } from 'zod';
import { blobPublicUrl } from '@/lib/contracts/public-uploads';

/** Un brano in evidenza letto dallo store Blob. durationSeconds 0 = sconosciuta (la legge il player). */
export const HomeTrackSchema = z.object({
  // Il pathname dell'oggetto su Blob: stabile e unico nello store.
  id: z.string().min(1).max(512),
  title: z.string().min(1).max(200),
  artist: z.string().max(200).nullable(),
  streamUrl: blobPublicUrl,
  durationSeconds: z.number().int().nonnegative().max(86_400),
});
export type HomeTrack = z.infer<typeof HomeTrackSchema>;

export const HomeTracksResponseSchema = z.object({
  items: z.array(HomeTrackSchema),
});
export type HomeTracksResponse = z.infer<typeof HomeTracksResponseSchema>;
