// @polsia:user-owned — contratto condiviso (client + route handler) per i "brani in evidenza" della
// Home: file audio che l'amministratore mette DIRETTAMENTE nello store Vercel Blob (dal pannello),
// elencati e riprodotti in Home. Non passano dal flusso di upload degli utenti (/pubblica).
import { z } from 'zod';

/** Prefisso del proxy same-origin che serve i brani in evidenza PRIVATI (lettura lato server). */
export const HOME_TRACK_STREAM_PREFIX = '/api/music/home-tracks/stream';
/** Prefisso della copertina servita da Solco (immagine privata o copertina incorporata nel file). */
export const HOME_TRACK_COVER_PREFIX = '/api/music/home-tracks/cover';
/** Titolo della sezione per i file messi nella radice dello store (fuori da ogni cartella). */
export const HOME_TRACKS_DEFAULT_SECTION = 'In evidenza';

function isPublicBlobHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.public.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

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
    (value) => value.startsWith(`${HOME_TRACK_STREAM_PREFIX}?p=`) || isPublicBlobHttpsUrl(value),
    { message: 'URL di riproduzione non valido.' },
  );

/**
 * Copertina: immagine pubblica sul CDN di Blob, oppure il percorso same-origin della copertina
 * (immagine privata o copertina incorporata nel file audio, letta dal server). null = nessuna.
 */
const homeTrackArtworkUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => value.startsWith(`${HOME_TRACK_COVER_PREFIX}?p=`) || isPublicBlobHttpsUrl(value),
    { message: 'URL della copertina non valido.' },
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
  /** Copertina del brano (stesso nome del file, copertina della cartella o incorporata). */
  artworkUrl: homeTrackArtworkUrl.nullable().default(null),
});
export type HomeTrack = z.infer<typeof HomeTrackSchema>;

/** Una sezione musicale: i brani di una cartella dello store (la radice è "In evidenza"). */
export const HomeTrackSectionSchema = z.object({
  id: z.string().max(1024),
  title: z.string().min(1).max(200),
  items: z.array(HomeTrackSchema),
});
export type HomeTrackSection = z.infer<typeof HomeTrackSectionSchema>;

export const HomeTracksResponseSchema = z.object({
  /** Tutti i brani mostrati, dal più recente (compatibilità con i client meno recenti). */
  items: z.array(HomeTrackSchema),
  /** Le stesse tracce divise per sezione (cartella), nell'ordine in cui mostrarle. */
  sections: z.array(HomeTrackSectionSchema).default([]),
});
export type HomeTracksResponse = z.infer<typeof HomeTracksResponseSchema>;
