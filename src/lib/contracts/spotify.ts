// @polsia:user-owned — contratto condiviso fra le route /api/spotify/* e la UI "Importa da Spotify".
// Solco trasferisce solo i METADATI delle playlist e dei brani salvati dell'utente (consentito dalla
// Spotify Developer Policy); nulla viene riprodotto da Spotify. I nomi dei campi Spotify usati dal
// server sono verificati sullo schema OpenAPI ufficiale.
import { z } from 'zod';

/** Spotify ID (base62, 22 caratteri). */
export const SpotifyIdSchema = z.string().regex(/^[A-Za-z0-9]{22}$/);

/** Playlist mostrate per pagina (Spotify: un insieme di contenuti mostra al massimo 20 elementi). */
export const SPOTIFY_PLAYLISTS_PAGE_SIZE = 20;
/** Sorgenti importabili in una volta: playlist scelte + "Brani salvati" (conta come una). */
export const SPOTIFY_IMPORT_MAX_SOURCES = 5;
/** Pagina di Spotify con cui chiudere ogni elenco ("Apri Spotify"). */
export const SPOTIFY_OPEN_URL = 'https://open.spotify.com';
/** Dove l'utente può revocare l'accesso di Solco anche dal lato Spotify. */
export const SPOTIFY_ACCOUNT_APPS_URL = 'https://www.spotify.com/account/apps/';

/** GET e DELETE /api/spotify/connection. Anche gli ospiti ricevono 200 con connected=false. */
export const ConnectionStatusSchema = z.object({
  /** false: SPOTIFY_CLIENT_ID mancante o origine non HTTPS → la UI non mostra nulla. */
  configured: z.boolean(),
  connected: z.boolean(),
  /**
   * true: collegato con un consenso precedente a cui manca uno scope ora richiesto
   * (playlist-read-collaborative): la UI chiede di ricollegare Spotify.
   */
  needsReconnect: z.boolean().default(false),
});
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const SpotifyPlaylistSchema = z.object({
  id: SpotifyIdSchema,
  /** Nome così come lo fornisce Spotify (può essere lungo: tronca con il testo intero nel title). */
  name: z.string(),
  /** owner.display_name; null se Spotify non lo fornisce. */
  owner: z.string().nullable(),
  /** Copertina più piccola di almeno 64 px (https), oppure null. */
  imageUrl: z.string().url().nullable(),
  /** Numero di elementi (items.total); null se Spotify non lo fornisce. */
  itemCount: z.number().int().nonnegative().nullable(),
  /** Link alla playlist su open.spotify.com (attribuzione obbligatoria). */
  spotifyUrl: z.string().url(),
  /**
   * false: playlist soltanto seguita (di un altro utente o di Spotify), di cui Spotify non
   * consente di leggere i brani: Spotify ne omette il campo `items`, presente solo per le playlist
   * di cui l'utente è proprietario o collaboratore. La UI la mostra senza poterla scegliere. Se
   * Spotify nega comunque la lettura di una playlist importabile, l'importazione lo segnala per
   * quella sola sorgente (spotify_forbidden).
   */
  importable: z.boolean(),
});
export type SpotifyPlaylist = z.infer<typeof SpotifyPlaylistSchema>;

/** GET /api/spotify/playlists?offset=N — letto dal vivo a ogni richiesta, mai salvato. */
export const SpotifyPlaylistsResponseSchema = z.object({
  playlists: z.array(SpotifyPlaylistSchema).max(SPOTIFY_PLAYLISTS_PAGE_SIZE),
  /** Totale dei brani salvati nella Libreria Spotify dell'utente. */
  savedTracks: z.number().int().nonnegative(),
  /** offset della pagina successiva; null quando le playlist sono finite. */
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type SpotifyPlaylistsResponse = z.infer<typeof SpotifyPlaylistsResponseSchema>;

/** POST /api/spotify/import. Almeno una sorgente, al massimo SPOTIFY_IMPORT_MAX_SOURCES in tutto. */
export const SpotifyImportRequestSchema = z
  .object({
    playlistIds: z.array(SpotifyIdSchema).max(SPOTIFY_IMPORT_MAX_SOURCES).default([]),
    /** true: importa anche i brani salvati ("Brani salvati su Spotify"). */
    saved: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.playlistIds.length > 0 || value.saved, {
    message: 'Scegli almeno una playlist o i brani salvati.',
  })
  .refine((value) => new Set(value.playlistIds).size === value.playlistIds.length, {
    message: 'Ogni playlist può essere scelta una sola volta.',
  })
  .refine(
    (value) => value.playlistIds.length + (value.saved ? 1 : 0) <= SPOTIFY_IMPORT_MAX_SOURCES,
    { message: `Puoi importare al massimo ${SPOTIFY_IMPORT_MAX_SOURCES} elementi per volta.` },
  );
export type SpotifyImportRequest = z.input<typeof SpotifyImportRequestSchema>;

/** Sorgente di un'importazione: l'id della playlist Spotify, oppure 'saved' per i brani salvati. */
export const SpotifyImportSourceSchema = z.union([SpotifyIdSchema, z.literal('saved')]);

export const SpotifyImportedPlaylistSchema = z.object({
  /** Playlist di Solco creata o aggiornata (UserMusicCollection.id). */
  collectionId: z.string().min(1),
  name: z.string().min(1),
  imported: z.number().int().nonnegative(),
  /** File locali, podcast, elementi vuoti e doppioni. */
  skipped: z.number().int().nonnegative(),
  /** Brani oltre il limite di 200 per playlist. */
  truncated: z.number().int().nonnegative(),
  source: SpotifyImportSourceSchema,
  /** Brani aggiunti rispetto a prima (= imported per una playlist nuova). */
  added: z.number().int().nonnegative(),
  /** Brani rimossi perché non più nella sorgente Spotify (solo per un aggiornamento). */
  removed: z.number().int().nonnegative(),
});

export const SpotifyImportFailureSchema = z.object({
  source: SpotifyImportSourceSchema,
  /** Codice stabile (es. 'spotify_forbidden', 'spotify_not_found', 'empty'). */
  error: z.string().min(1),
  /** Messaggio in italiano da mostrare all'utente. */
  message: z.string().min(1),
});

export const SpotifyImportResponseSchema = z.object({
  created: z.array(SpotifyImportedPlaylistSchema),
  /** Sorgenti già importate prima e ora RISINCRONIZZATE (stessa playlist Solco, specchio esatto). */
  updated: z.array(SpotifyImportedPlaylistSchema).default([]),
  /** Sorgenti non importate (es. playlist seguite ma non tue: Spotify ne nega la lettura). */
  failed: z.array(SpotifyImportFailureSchema).default([]),
});
export type SpotifyImportResponse = z.infer<typeof SpotifyImportResponseSchema>;

/**
 * POST /api/spotify/sync — "Aggiorna da Spotify": risincronizza TUTTE le sorgenti già importate
 * (brani salvati + ogni playlist importata) nelle rispettive playlist Solco, a specchio esatto.
 */
export const SpotifySyncResponseSchema = z.object({
  updated: z.array(SpotifyImportedPlaylistSchema),
  failed: z.array(SpotifyImportFailureSchema).default([]),
  /** true quando l'utente non ha ancora importato nulla da Spotify (niente da aggiornare). */
  nothingToSync: z.boolean().default(false),
});
export type SpotifySyncResponse = z.infer<typeof SpotifySyncResponseSchema>;

/**
 * Corpo di ogni errore delle route /api/spotify/*: `{ error, message }` (italiano) e, per i 429,
 * `retryAfterSeconds`. Codici: spotify_not_configured (404), spotify_reauth (401: collega o
 * ricollega Spotify), spotify_scope_outdated (401: consenso precedente senza uno scope ora
 * richiesto, il collegamento resta finché non si ricollega), spotify_not_allowlisted (403: app in modalità sviluppo), spotify_forbidden
 * (403), spotify_not_found (404), spotify_rate_limited (429), spotify_quota_exceeded (429:
 * quota della modalità sviluppo esaurita; retryAfterSeconds solo se Spotify invia Retry-After),
 * spotify_unavailable (502/503),
 * limit_reached (409: troppe playlist in Solco), invalid_request (400), forbidden_origin (403),
 * più quelli comuni rate_limited / invalid_json / payload_too_large.
 */
export const SpotifyApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  retryAfterSeconds: z.number().int().positive().optional(),
});
export type SpotifyApiError = z.infer<typeof SpotifyApiErrorSchema>;

/**
 * Motivi fissi in /library?spotify=error&reason=… dopo il ritorno da Spotify (mai testo arbitrario).
 * denied: l'utente ha annullato · expired: richiesta scaduta o cookie assente · invalid_state:
 * verifica di sicurezza fallita · session: account Solco diverso o uscito · not_allowlisted: account
 * Spotify non abilitato (modalità sviluppo) · rate_limited: troppe richieste
 * (anche la quota della modalità sviluppo esaurita) · failed: errore di
 * Spotify o dello scambio del codice.
 */
export const SpotifyCallbackReasonSchema = z.enum([
  'denied',
  'expired',
  'invalid_state',
  'session',
  'not_allowlisted',
  'rate_limited',
  'failed',
]);
export type SpotifyCallbackReason = z.infer<typeof SpotifyCallbackReasonSchema>;
