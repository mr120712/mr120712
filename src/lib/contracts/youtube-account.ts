// @polsia:user-owned — contratto condiviso fra le route /api/music/youtube/* e la UI "Connetti
// YouTube". Solco importa solo i METADATI (videoId + titolo/canale/copertina) delle playlist
// dell'utente; nulla viene ri-ospitato (riproduzione on-demand). I nomi dei campi della YouTube
// Data API usati dal server sono quelli ufficiali (playlists.list / playlistItems.list).
import { z } from 'zod';

/** ID di una playlist YouTube (es. "PL…"): lettere/cifre/trattini, 10–64 caratteri. */
export const YouTubePlaylistIdSchema = z.string().regex(/^[A-Za-z0-9_-]{10,64}$/);

/** Massimo di playlist importabili in una volta. */
export const YOUTUBE_IMPORT_MAX_SOURCES = 5;
/** Pagina pubblica di YouTube ("Apri YouTube"). */
export const YOUTUBE_OPEN_URL = 'https://www.youtube.com';
/** Dove l'utente può revocare l'accesso di Solco lato Google. */
export const GOOGLE_ACCOUNT_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

/** GET e DELETE /api/music/youtube/connection. Anche gli ospiti ricevono 200 con connected=false. */
export const YouTubeConnectionStatusSchema = z.object({
  /** false: GOOGLE_CLIENT_ID/SECRET mancanti o origine non HTTPS → la UI non mostra nulla. */
  configured: z.boolean(),
  connected: z.boolean(),
});
export type YouTubeConnectionStatus = z.infer<typeof YouTubeConnectionStatusSchema>;

export const YouTubeAccountPlaylistSchema = z.object({
  id: YouTubePlaylistIdSchema,
  /** Titolo così come lo fornisce YouTube. */
  title: z.string().min(1),
  /** Numero di elementi (contentDetails.itemCount); null se non fornito. */
  itemCount: z.number().int().nonnegative().nullable(),
  /** Copertina https, oppure null. */
  thumbnailUrl: z.string().url().nullable(),
});
export type YouTubeAccountPlaylist = z.infer<typeof YouTubeAccountPlaylistSchema>;

/** GET /api/music/youtube/playlists?pageToken=… — letto dal vivo, mai salvato. */
export const YouTubePlaylistsResponseSchema = z.object({
  playlists: z.array(YouTubeAccountPlaylistSchema).max(200),
  /** token della pagina successiva; null quando le playlist sono finite. */
  nextPageToken: z.string().min(1).nullable(),
});
export type YouTubePlaylistsResponse = z.infer<typeof YouTubePlaylistsResponseSchema>;

/** POST /api/music/youtube/import. Almeno una, al massimo YOUTUBE_IMPORT_MAX_SOURCES. */
export const YouTubeAccountImportRequestSchema = z
  .object({
    playlistIds: z.array(YouTubePlaylistIdSchema).min(1).max(YOUTUBE_IMPORT_MAX_SOURCES),
  })
  .strict()
  .refine((value) => new Set(value.playlistIds).size === value.playlistIds.length, {
    message: 'Ogni playlist può essere scelta una sola volta.',
  });
export type YouTubeAccountImportRequest = z.input<typeof YouTubeAccountImportRequestSchema>;

export const YouTubeImportedPlaylistSchema = z.object({
  /** Playlist di Solco creata o aggiornata (UserMusicCollection.id). */
  collectionId: z.string().min(1),
  name: z.string().min(1),
  playlistId: YouTubePlaylistIdSchema,
  imported: z.number().int().nonnegative(),
  /** Video privati/eliminati e doppioni. */
  skipped: z.number().int().nonnegative(),
  /** Video aggiunti rispetto a prima (= imported per una playlist nuova). */
  added: z.number().int().nonnegative(),
  /** Video rimossi perché non più nella playlist YouTube (solo per un aggiornamento). */
  removed: z.number().int().nonnegative(),
});

export const YouTubeImportFailureSchema = z.object({
  playlistId: YouTubePlaylistIdSchema,
  /** Codice stabile (es. 'youtube_forbidden', 'youtube_not_found', 'empty'). */
  error: z.string().min(1),
  message: z.string().min(1),
});

export const YouTubeAccountImportResponseSchema = z.object({
  created: z.array(YouTubeImportedPlaylistSchema),
  /** Playlist già importate prima e ora RISINCRONIZZATE (stessa playlist Solco, specchio esatto). */
  updated: z.array(YouTubeImportedPlaylistSchema).default([]),
  failed: z.array(YouTubeImportFailureSchema).default([]),
});
export type YouTubeAccountImportResponse = z.infer<typeof YouTubeAccountImportResponseSchema>;

/**
 * POST /api/music/youtube/sync — "Aggiorna da YouTube": risincronizza TUTTE le playlist già
 * importate nelle rispettive playlist Solco, a specchio esatto.
 */
export const YouTubeSyncResponseSchema = z.object({
  updated: z.array(YouTubeImportedPlaylistSchema),
  failed: z.array(YouTubeImportFailureSchema).default([]),
  /** true quando l'utente non ha ancora importato nulla da YouTube. */
  nothingToSync: z.boolean().default(false),
});
export type YouTubeSyncResponse = z.infer<typeof YouTubeSyncResponseSchema>;

/**
 * Corpo di ogni errore delle route /api/music/youtube/*: `{ error, message }` (italiano) e, per i
 * 429, `retryAfterSeconds`. Codici: youtube_not_configured (404), youtube_reauth (401),
 * youtube_forbidden (403), youtube_not_found (404), youtube_rate_limited (429),
 * youtube_quota_exceeded (429), youtube_unavailable (502/503), limit_reached (409),
 * invalid_request (400), forbidden_origin (403), più i comuni invalid_json / payload_too_large.
 */
export const YouTubeApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  retryAfterSeconds: z.number().int().positive().optional(),
});
export type YouTubeApiError = z.infer<typeof YouTubeApiErrorSchema>;

/**
 * Motivi fissi in /library?youtube=error&reason=… dopo il ritorno da Google (mai testo arbitrario).
 * denied: l'utente ha annullato · expired: richiesta scaduta o cookie assente · invalid_state:
 * verifica di sicurezza fallita · session: account Solco diverso o uscito · rate_limited: troppe
 * richieste · failed: errore di Google o dello scambio del codice.
 */
export const YouTubeCallbackReasonSchema = z.enum([
  'denied',
  'expired',
  'invalid_state',
  'session',
  'rate_limited',
  'failed',
]);
export type YouTubeCallbackReason = z.infer<typeof YouTubeCallbackReasonSchema>;
