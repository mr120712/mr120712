// @polsia:user-owned — contratto condiviso (client + route handler) per i "brani in evidenza" della
// Home: file audio che l'amministratore mette DIRETTAMENTE nello store Vercel Blob (dal pannello),
// elencati e riprodotti in Home. Non passano dal flusso di upload degli utenti (/pubblica).
import { z } from 'zod';
import { ARTIST_SLUG_MAX_LENGTH, ARTIST_SLUG_PATTERN } from '@/lib/music/featured-artists';
import { FEATURED_SECTION_ID_PATTERN } from '@/lib/music/featured-sections';
import { FEATURED_SHARE_ID_PATTERN } from '@/lib/music/featured-share';

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

/**
 * Slug della pagina /artista/<slug> (vedi featured-artists.ts): minuscole e cifre separate da un
 * trattino, al massimo 80 caratteri.
 */
export const FeaturedArtistSlugSchema = z
  .string()
  .min(1)
  .max(ARTIST_SLUG_MAX_LENGTH)
  .regex(ARTIST_SLUG_PATTERN);

/**
 * Id opaco del link diretto /evidenza/<id> (vedi featured-share.ts): 22 caratteri base64url,
 * calcolato dal server, mai il pathname del file.
 */
export const FeaturedShareIdSchema = z.string().regex(FEATURED_SHARE_ID_PATTERN);

/**
 * Id opaco della pagina «Mostra tutti» di una sezione (/cartella/<id>, vedi featured-sections.ts):
 * 22 caratteri base64url calcolati dal server, mai il percorso della cartella nello store.
 */
export const FeaturedSectionIdSchema = z.string().regex(FEATURED_SECTION_ID_PATTERN);

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
  /**
   * Pagina dell'artista principale (/artista/<slug>), SOLO se ha almeno un brano con i diritti
   * dichiarati in diritti.json: nessun link porta a una pagina vuota. null o assente = nessun link
   * (anche dai server meno recenti, che non lo mandano).
   */
  artistSlug: FeaturedArtistSlugSchema.nullable().optional(),
  /**
   * Link diretto «Condividi» (/evidenza/<shareId>), SOLO per i brani con i diritti dichiarati in
   * diritti.json: un brano non dichiarato non ha link (nessun pulsante). null o assente = nessun
   * link (anche con la condivisione spenta o dai server meno recenti).
   */
  shareId: FeaturedShareIdSchema.nullable().optional(),
  /**
   * Copia offline («Scarica offline» in «La tua musica»), SOLO per i brani DICHIARATI in
   * diritti.json: true = la voce la consente (licenza propria/Creative Commons senza
   * "offline": false, oppure "offline": true), false = solo streaming. Calcolato dal server sul
   * manifest; assente per i brani non dichiarati (e dai server meno recenti) = nessun download.
   * Il permesso vero lo ricontrolla la rotta di download a ogni richiesta.
   */
  offline: z.boolean().optional(),
});
export type HomeTrack = z.infer<typeof HomeTrackSchema>;

/**
 * Lo stesso brano con `artworkUrl` obbligatorio (null = nessuna copertina), per i contratti che lo
 * incorporano (ricerca globale): forma identica in ingresso e in uscita, il server la manda sempre.
 */
export const HomeTrackResultSchema = HomeTrackSchema.extend({
  artworkUrl: homeTrackArtworkUrl.nullable(),
});

/** Una sezione musicale: i brani di una cartella dello store (la radice è "In evidenza"). */
export const HomeTrackSectionSchema = z.object({
  id: z.string().max(1024),
  title: z.string().min(1).max(200),
  items: z.array(HomeTrackSchema),
  /**
   * «Mostra tutti»: la pagina /cartella/<sectionId> con i brani della cartella DICHIARATI in
   * diritti.json (mai quelli non dichiarati), SOLO se ce n'è almeno uno. null o assente = nessun
   * link (anche dai server meno recenti, che non lo mandano).
   */
  sectionId: FeaturedSectionIdSchema.nullable().optional(),
  /**
   * Quanti brani dichiarati elenca quella pagina (il numero di «Mostra tutti (N)»). null, assente
   * o 0 = nessun link. Nessun tetto stretto qui: un numero più alto non deve mai far scartare
   * l'intera Home a un client meno recente.
   */
  declaredCount: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
});
export type HomeTrackSection = z.infer<typeof HomeTrackSectionSchema>;

/**
 * Versione del catalogo dei brani in evidenza: 16 cifre esadecimali calcolate dal server
 * dall'impronta dello store (vedi featured-catalog.server). Cambia quando l'amministratore aggiunge,
 * toglie o sostituisce un brano, una copertina, un testo o diritti.json, o preme «Aggiorna ora».
 */
export const HomeTracksVersionValueSchema = z.string().regex(/^[0-9a-f]{16}$/);

export const HomeTracksResponseSchema = z.object({
  /** Tutti i brani mostrati, dal più recente (compatibilità con i client meno recenti). */
  items: z.array(HomeTrackSchema),
  /** Le stesse tracce divise per sezione (cartella), nell'ordine in cui mostrarle. */
  sections: z.array(HomeTrackSectionSchema).default([]),
  /**
   * La versione del catalogo di QUESTO contenuto, solo se definitivo (link pronti, elenco non
   * degradato). Assente = il client lo richiede al controllo successivo (anche dai server meno
   * recenti, che non la mandano).
   */
  version: HomeTracksVersionValueSchema.optional(),
  /**
   * Quando è riuscito l'elenco dello store dietro questa risposta (ISO). Il client non applica un
   * elenco più vecchio di quello che mostra (istanza rimasta indietro). Assente dai server meno
   * recenti o senza un elenco buono.
   */
  listedAt: z.string().datetime().optional(),
});
export type HomeTracksResponse = z.infer<typeof HomeTracksResponseSchema>;

/** GET /api/music/home-tracks/version: la versione attuale del catalogo (nessun dato utente). */
export const HomeTracksVersionSchema = z.object({
  version: HomeTracksVersionValueSchema,
  /** Quando il server ha visto per la prima volta questa versione (ISO). */
  updatedAt: z.string().datetime(),
  /**
   * Quando è riuscito l'elenco dello store che conferma questa versione (ISO). Va solo avanti: il
   * client ignora una versione con un `listedAt` più vecchio di quello che mostra, così non torna
   * mai indietro se due istanze sono sfasate per qualche secondo.
   */
  listedAt: z.string().datetime().optional(),
});
export type HomeTracksVersion = z.infer<typeof HomeTracksVersionSchema>;
