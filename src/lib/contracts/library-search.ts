// @polsia:user-owned — contratto di GET /api/music/library/search?q=…: la ricerca nella Libreria
// dell'ascoltatore (le sue playlist, i Preferiti e i brani che contengono) per la sezione «Le tue
// playlist» della pagina Cerca. È un endpoint SEPARATO e privato (sessione obbligatoria, mai in
// cache condivisa): GET /api/music/search-all resta pubblico e cacheabile in CDN e non porta mai
// dati di un utente. Gli elementi dei brani hanno gli stessi campi (e le stesse regole sugli
// indirizzi) degli elementi della Libreria, così suonano con la stessa conversione del player.
import { z } from 'zod';
import { MusicCollectionItemSchema, MusicCollectionKindSchema } from '@/lib/contracts/music';

/** Stessa regola della ricerca unificata: testo ripulito dagli spazi, da 1 a 80 caratteri. */
export const LIBRARY_SEARCH_QUERY_MAX_LENGTH = 80;
export const LIBRARY_SEARCH_QUERY_ERROR = 'Inserisci una ricerca da 1 a 80 caratteri.';
/** Raccolte (playlist e Preferiti) mostrate per ricerca. */
export const LIBRARY_SEARCH_COLLECTION_LIMIT = 6;
/** Brani delle raccolte mostrati per ricerca. */
export const LIBRARY_SEARCH_TRACK_LIMIT = 10;
/** Copertine per il mosaico 2×2 di una raccolta (come PLAYLIST_MOSAIC_TILES). */
export const LIBRARY_SEARCH_COVER_LIMIT = 4;

export const LibrarySearchQuerySchema = z
  .string()
  .trim()
  .min(1, LIBRARY_SEARCH_QUERY_ERROR)
  .max(LIBRARY_SEARCH_QUERY_MAX_LENGTH, LIBRARY_SEARCH_QUERY_ERROR);

/** Copertina valida per il mosaico: la stessa regola (https) delle copertine della Libreria. */
export const LibrarySearchCoverSchema = MusicCollectionItemSchema.shape.artworkUrl.unwrap();

/** Una raccolta dell'ascoltatore che corrisponde alla ricerca (nome o descrizione). */
export const LibrarySearchCollectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: MusicCollectionKindSchema,
  /** Solo le playlist hanno una descrizione (ripulita come nella Libreria); null altrimenti. */
  description: z.string().min(1).nullable(),
  /** Tutti gli elementi della raccolta, come il conteggio della Libreria. */
  itemCount: z.number().int().nonnegative(),
  /** Le prime copertine diverse nell'ordine della Libreria (mai di metadati YouTube scaduti). */
  covers: z.array(LibrarySearchCoverSchema).max(LIBRARY_SEARCH_COVER_LIMIT),
});

/**
 * Un brano salvato in una raccolta che corrisponde alla ricerca (titolo o artista). Gli stessi
 * campi dell'elemento della Libreria che servono al player (collectionItemToTrack), più la raccolta
 * in cui si trova; `otherCollectionCount` conta le ALTRE raccolte che contengono lo stesso brano
 * (che compare una volta sola). Mai metadati YouTube scaduti: un video oltre la conservazione non
 * ha più titolo e non può corrispondere.
 */
export const LibrarySearchTrackSchema = MusicCollectionItemSchema.pick({
  id: true,
  source: true,
  sourceId: true,
  creatorName: true,
  artworkUrl: true,
  sourceUrl: true,
  artistUrl: true,
  durationSeconds: true,
}).extend({
  title: z.string().min(1),
  collectionId: z.string().min(1),
  collectionName: z.string().min(1),
  collectionKind: MusicCollectionKindSchema,
  otherCollectionCount: z.number().int().nonnegative(),
});

export const LibrarySearchResponseSchema = z.object({
  query: LibrarySearchQuerySchema,
  collections: z.array(LibrarySearchCollectionSchema).max(LIBRARY_SEARCH_COLLECTION_LIMIT),
  tracks: z.array(LibrarySearchTrackSchema).max(LIBRARY_SEARCH_TRACK_LIMIT),
});

export type LibrarySearchCollection = z.infer<typeof LibrarySearchCollectionSchema>;
export type LibrarySearchTrack = z.infer<typeof LibrarySearchTrackSchema>;
export type LibrarySearchResponse = z.infer<typeof LibrarySearchResponseSchema>;
