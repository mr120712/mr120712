// @polsia:user-owned — contratti condivisi (client + route) di audio.com: il brano mostrato nella
// ricerca unificata e lo stato del collegamento nella pagina admin «audio.com».
//
// Un brano arriva al client con la licenza normalizzata e, SOLO se la licenza permette di
// riprodurlo in Solco (CC0 / CC BY / CC BY-SA / CC BY-ND, vedi audiocom-license.ts) e non è una
// cover, con lo stream https di audio.com: per ogni altra licenza e per ogni cover `streamUrl` è
// sempre null (il contratto lo impone), così il client non ha nemmeno l'indirizzo da riprodurre.
// Il player ufficiale (iframe) si ricava dall'id con audioComEmbedUrl.
import { z } from 'zod';
import {
  AUDIOCOM_ID_PATTERN,
  AUDIOCOM_LICENSE_VALUES,
  audioComImageUrl,
  audioComStreamUrl,
  isAudioComPageUrl,
  isAudioComStreamAllowed,
} from '@/lib/music/audiocom-license';

/** Categorie di audio.com tenute nella ricerca musicale (niente podcast, voce, effetti…). */
export const AUDIOCOM_MUSIC_CATEGORIES = ['music', 'cover', 'beats'] as const;

export const AudioComTrackSchema = z
  .object({
    id: z.string().regex(AUDIOCOM_ID_PATTERN),
    title: z.string().min(1).max(300),
    authorName: z.string().min(1).max(200),
    /** https://audio.com/{username}/audio/{slug}: link «su audio.com» dell'attribuzione. */
    pageUrl: z.string().max(600).refine(isAudioComPageUrl, 'Pagina audio.com non valida'),
    imageUrl: z
      .string()
      .nullable()
      .refine(
        (value) => value === null || audioComImageUrl(value) === value,
        'Copertina non valida',
      ),
    streamUrl: z
      .string()
      .nullable()
      .refine((value) => value === null || audioComStreamUrl(value) === value, 'Stream non valido'),
    durationSeconds: z.number().int().positive().max(86_400).nullable(),
    category: z.enum(AUDIOCOM_MUSIC_CATEGORIES),
    license: z.enum(AUDIOCOM_LICENSE_VALUES),
  })
  .refine((track) => track.streamUrl === null || isAudioComStreamAllowed(track), {
    message: 'Uno stream è ammesso solo con una licenza riproducibile in Solco e mai per una cover',
    path: ['streamUrl'],
  });
export type AudioComTrack = z.infer<typeof AudioComTrackSchema>;

/**
 * Stato della fonte audio.com nella ricerca unificata (solo per i client che la chiedono):
 * - `results` / `empty`: audio.com ha risposto (con o senza brani musicali);
 * - `unavailable`: errore, limite di richieste (nostro o di audio.com), oltre il tempo massimo;
 * - `disconnected`: nessun account audio.com collegato dall'amministratore;
 * - `skipped`: ricerca troppo corta per interrogare audio.com.
 */
export const AudioComSourceStatusSchema = z.enum([
  'results',
  'empty',
  'unavailable',
  'disconnected',
  'skipped',
]);
export type AudioComSourceStatus = z.infer<typeof AudioComSourceStatusSchema>;

/** Ultimo problema del collegamento (codici fissi: nessun testo dall'esterno, nessun token). */
export const AUDIOCOM_ERROR_CODES = [
  'reauth_required',
  'refresh_failed',
  'search_unauthorized',
  'rate_limited',
  'search_failed',
  'invalid_response',
] as const;
export type AudioComErrorCode = (typeof AUDIOCOM_ERROR_CODES)[number];

/** GET /api/admin/audiocom: stato del collegamento (mai i token). */
export const AudioComConnectionStatusSchema = z.object({
  /** false: manca NEXT_PUBLIC_APP_URL https valido o BETTER_AUTH_SECRET (chiave di cifratura). */
  configured: z.boolean(),
  connected: z.boolean(),
  /** Era collegato ma i token non valgono più: va ricollegato. */
  needsReconnect: z.boolean(),
  /** Il client OAuth di Solco è già registrato presso audio.com (registrazione dinamica, una volta). */
  clientRegistered: z.boolean(),
  accountName: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastError: z.enum(AUDIOCOM_ERROR_CODES).nullable(),
  lastErrorAt: z.string().nullable(),
  /** Indirizzo di ritorno registrato presso audio.com (per verifica). */
  redirectUri: z.string().nullable(),
});
export type AudioComConnectionStatus = z.infer<typeof AudioComConnectionStatusSchema>;
