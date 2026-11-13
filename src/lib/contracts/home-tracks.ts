// @polsia:user-owned — contratto condiviso (client + route handler) per i "brani in evidenza" della
// Home: file audio che l'amministratore mette DIRETTAMENTE nel bucket AWS S3 (dalla console),
// elencati e riprodotti in Home. Non passano dal flusso di upload degli utenti (/pubblica).
import { z } from 'zod';

/**
 * URL di riproduzione di un brano in evidenza: un URL GET firmato (presigned) prodotto dal server a
 * partire dalla chiave dell'oggetto su S3. Basta esigere https (il valore è sempre derivato dal
 * server, mai dal client); la riproduzione passa comunque da `media-src 'https:'`.
 */
const homeTrackStreamUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'URL di riproduzione non valido.' },
  );

/** Un brano in evidenza letto dal bucket S3. durationSeconds 0 = sconosciuta (la legge il player). */
export const HomeTrackSchema = z.object({
  // La chiave dell'oggetto su S3: stabile e unica nel bucket. Le chiavi S3 arrivano fino a 1024
  // caratteri (come nel contratto degli upload utenti): non tagliare più corto, altrimenti un file
  // dal nome/cartella lunghi verrebbe scartato in silenzio.
  id: z.string().min(1).max(1024),
  title: z.string().min(1).max(200),
  artist: z.string().max(200).nullable(),
  streamUrl: homeTrackStreamUrl,
  durationSeconds: z.number().int().nonnegative().max(86_400),
});
export type HomeTrack = z.infer<typeof HomeTrackSchema>;

export const HomeTracksResponseSchema = z.object({
  items: z.array(HomeTrackSchema),
});
export type HomeTracksResponse = z.infer<typeof HomeTracksResponseSchema>;
