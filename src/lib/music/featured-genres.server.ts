// @polsia:user-owned — «Per genere» dei "brani in evidenza" (lato server): id opaco di ogni genere e
// raggruppamento dei SOLI brani dichiarati in diritti.json per il loro "genere". Lo usa l'indice di
// featured-search.server mentre si costruisce (stesso elenco condiviso dello store e stesso
// manifest: nessuna lettura in più).
//
// Id: base64url(SHA-256("featured-genre:v1:" + chiave del genere)), primi 22 caratteri. Stessa
// forma degli id delle cartelle (featured-sections.server), così la pagina /cartella/<id> e la sua
// API servono anche i generi; il contesto dell'hash è diverso, quindi un genere e una cartella con lo
// stesso nome hanno id diversi. Se un id coincidesse con quello di una cartella, o due generi
// avessero lo stesso id (132 bit: in pratica mai), quei generi restano senza pagina: un link non
// porta mai alla cartella sbagliata.
// Un brano senza voce valida in diritti.json, o con una voce senza "genere", non è in nessun genere:
// i brani non dichiarati non sono mai elencati né contati.
import 'server-only';
import { createHash } from 'node:crypto';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import {
  FEATURED_GENRE_COVERS,
  FEATURED_HOME_GENRES_MAX,
  featuredGenreKey,
  featuredGenreLabel,
} from '@/lib/music/featured-genres';
import {
  FEATURED_SECTION_ID_LENGTH,
  FEATURED_SECTION_TRACK_LIMIT,
} from '@/lib/music/featured-sections';

/** Contesto dell'hash: tiene questi id separati da quelli delle cartelle e da ogni altro uso. */
export const FEATURED_GENRE_CONTEXT = 'featured-genre:v1:';

/** Un genere con brani dichiarati: la sua pagina /cartella/<id>. */
export type FeaturedGenreGroup = {
  /** Id opaco della pagina /cartella/<id>. */
  id: string;
  /** Chiave del genere (featuredGenreKey: senza maiuscole né spazi doppi). */
  key: string;
  /** Il nome come lo scrive la voce del brano più recente del genere. */
  name: string;
  /** I brani DICHIARATI del genere, dal più recente (al massimo il tetto della pagina). */
  tracks: HomeTrack[];
};

/** Un riquadro «Per genere» della Home: SOLO dai brani dichiarati. */
export type FeaturedHomeGenre = {
  id: string;
  name: string;
  /** Quanti brani dichiarati elenca la pagina del genere (sempre > 0). */
  count: number;
  /** Le prime copertine diverse dei suoi brani (per il mosaico), al massimo 4. */
  artworkUrls: string[];
};

/** L'id della pagina di un genere (chiave featuredGenreKey). */
export function featuredGenreId(genreKey: string): string {
  return createHash('sha256')
    .update(`${FEATURED_GENRE_CONTEXT}${genreKey}`)
    .digest('base64url')
    .slice(0, FEATURED_SECTION_ID_LENGTH);
}

/**
 * I generi dei brani DICHIARATI (`declared`, già dal più recente, ognuno con il "genere" della sua
 * voce o null), per id: prima i generi con più brani, a parità in ordine alfabetico. Un brano
 * senza genere non compare; in ogni genere al massimo `limit` brani. `reservedIds` sono gli id
 * delle cartelle: un genere con lo stesso id resta senza pagina, come due generi con lo stesso id
 * (`idOf` si cambia solo nei test, per provocare una collisione).
 */
export function groupFeaturedGenres(
  declared: ReadonlyArray<{ track: HomeTrack; genre: string | null | undefined }>,
  reservedIds: ReadonlySet<string> = new Set(),
  limit = FEATURED_SECTION_TRACK_LIMIT,
  idOf: (genreKey: string) => string = featuredGenreId,
): ReadonlyMap<string, FeaturedGenreGroup> {
  const buckets = new Map<string, { key: string; name: string; tracks: HomeTrack[] }>();
  for (const { track, genre } of declared) {
    if (typeof genre !== 'string') continue;
    const name = featuredGenreLabel(genre);
    if (name.length === 0) continue;
    const key = featuredGenreKey(genre);
    const bucket = buckets.get(key);
    if (!bucket) buckets.set(key, { key, name, tracks: [track] });
    else if (bucket.tracks.length < limit) bucket.tracks.push(track);
  }
  if (buckets.size === 0) return new Map();

  const ordered = [...buckets.values()].sort(
    (a, b) =>
      b.tracks.length - a.tracks.length ||
      a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const ids = ordered.map((bucket) => idOf(bucket.key));
  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);

  const genres = new Map<string, FeaturedGenreGroup>();
  for (const [index, bucket] of ordered.entries()) {
    const id = ids[index];
    if (!id || seen.get(id) !== 1 || reservedIds.has(id)) continue;
    genres.set(id, { id, key: bucket.key, name: bucket.name, tracks: bucket.tracks });
  }
  return genres;
}

/** Le prime `limit` copertine diverse dei brani (nell'ordine dei brani); i brani senza si saltano. */
function coversOf(tracks: readonly HomeTrack[], limit = FEATURED_GENRE_COVERS): string[] {
  const covers: string[] = [];
  for (const track of tracks) {
    if (covers.length >= limit) break;
    const url = track.artworkUrl;
    if (url && !covers.includes(url)) covers.push(url);
  }
  return covers;
}

/** I riquadri «Per genere» della Home, nell'ordine dei generi (al massimo `max`). */
export function featuredHomeGenres(
  genres: Iterable<FeaturedGenreGroup>,
  max = FEATURED_HOME_GENRES_MAX,
): FeaturedHomeGenre[] {
  const tiles: FeaturedHomeGenre[] = [];
  for (const genre of genres) {
    if (tiles.length >= max) break;
    if (genre.tracks.length === 0) continue;
    tiles.push({
      id: genre.id,
      name: genre.name,
      count: genre.tracks.length,
      artworkUrls: coversOf(genre.tracks),
    });
  }
  return tiles;
}
