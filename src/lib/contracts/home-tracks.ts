// @polsia:user-owned — contratto condiviso (client + route handler) per i "brani in evidenza" della
// Home: file audio che l'amministratore mette DIRETTAMENTE nello store Vercel Blob (dal pannello),
// elencati e riprodotti in Home. Non passano dal flusso di upload degli utenti (/pubblica).
import { z } from 'zod';

/** Prefisso del proxy same-origin che serve i brani in evidenza PRIVATI (lettura lato server). */
export const HOME_TRACK_STREAM_PREFIX = '/api/music/home-tracks/stream';

/**
 * URL di riproduzione di un brano in evidenza. Due forme possibili:
 *  - un URL CDN https su un host *.public.blob.vercel-storage.com (file reso pubblico: stream diretto);
 *  - un percorso same-origin del proxy (file privato: lo stream passa dal server con il token).
 */
const homeTrackStreamUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => {
      if (value.startsWith(`${HOME_TRACK_STREAM_PREFIX}?p=`)) return true;
      try {
        const url = new URL(value);
        return (
          url.protocol === 'https:' && url.hostname.endsWith('.public.blob.vercel-storage.com')
        );
      } catch {
        return false;
      }
    },
    { message: 'URL di riproduzione non valido.' },
  );

/** Un brano in evidenza letto dallo store Blob. durationSeconds 0 = sconosciuta (la legge il player). */
export const HomeTrackSchema = z.object({
  // Il pathname dell'oggetto su Blob: stabile e unico nello store. I pathname di Vercel Blob
  // arrivano fino a 1024 caratteri (come nel contratto degli upload utenti): non tagliare più corto,
  // altrimenti un file dal nome/cartella lunghi verrebbe scartato in silenzio.
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
