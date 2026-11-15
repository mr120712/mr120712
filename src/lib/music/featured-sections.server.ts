// @polsia:user-owned — sezioni «Mostra tutti» dei "brani in evidenza" (lato server): id opaco di
// ogni cartella e raggruppamento dei SOLI brani dichiarati in diritti.json per cartella. Lo usa
// l'indice di featured-search.server mentre si costruisce (stesso elenco condiviso dello store,
// nessuna list() in più).
//
// Id: base64url(SHA-256("featured-section:v1:" + chiave della cartella)), primi 22 caratteri.
// - Stabile: dipende solo dalla cartella (senza maiuscole, come la raggruppa la Home), non dalla
//   build né da un segreto: un link resta valido finché la cartella ha brani dichiarati.
// - Sicuro negli URL (base64url) e senza collisioni in pratica (132 bit); due cartelle con lo
//   stesso id restano comunque ENTRAMBE senza link, così un link non porta mai alla cartella
//   sbagliata.
// - Nessun segreto serve: i nomi delle cartelle sono già i titoli delle sezioni in Home, e un id
//   indovinato di una cartella senza brani dichiarati risponde 404 come un id inventato.
// Una cartella senza brani dichiarati non ha id né pagina: i brani non dichiarati non sono mai
// elencati né contati.
import 'server-only';
import { createHash } from 'node:crypto';
import { HOME_TRACKS_DEFAULT_SECTION, type HomeTrack } from '@/lib/contracts/home-tracks';
import {
  FEATURED_SECTION_ID_LENGTH,
  FEATURED_SECTION_TRACK_LIMIT,
} from '@/lib/music/featured-sections';
import {
  type HomeFolder,
  homeFolderKey,
  sectionTitleFromDirectory,
} from '@/lib/music/home-tracks.server';

/** Contesto dell'hash: tiene questi id separati da ogni altro uso. */
export const FEATURED_SECTION_CONTEXT = 'featured-section:v1:';

/** Una sezione con brani dichiarati: la sua pagina «Mostra tutti». */
export type FeaturedSectionGroup = {
  /** Id opaco della pagina /cartella/<id>. */
  id: string;
  /** Chiave della cartella (homeFolderKey): '' per la radice. */
  key: string;
  /** Titolo con le stesse regole della Home. */
  title: string;
  /** I brani DICHIARATI della cartella, dal più recente (al massimo il tetto). */
  tracks: HomeTrack[];
};

/** L'id della sezione di una cartella (chiave homeFolderKey; '' = radice). */
export function featuredSectionId(folderKey: string): string {
  return createHash('sha256')
    .update(`${FEATURED_SECTION_CONTEXT}${folderKey}`)
    .digest('base64url')
    .slice(0, FEATURED_SECTION_ID_LENGTH);
}

/**
 * Le sezioni dei brani DICHIARATI (`declared`, già dal più recente), una per cartella, per id e
 * nell'ordine della Home (`folders`). Una cartella senza brani dichiarati non compare; in ognuna
 * al massimo `limit` brani. Due cartelle con lo stesso id restano entrambe senza pagina (`idOf` si
 * cambia solo nei test, per provocare una collisione).
 */
export function groupFeaturedSections(
  declared: readonly HomeTrack[],
  folders: readonly HomeFolder[],
  limit = FEATURED_SECTION_TRACK_LIMIT,
  idOf: (folderKey: string) => string = featuredSectionId,
): ReadonlyMap<string, FeaturedSectionGroup> {
  const byKey = new Map<string, { directory: string; tracks: HomeTrack[] }>();
  for (const track of declared) {
    const key = homeFolderKey(track.id);
    const bucket = byKey.get(key);
    if (!bucket) {
      const slash = track.id.lastIndexOf('/');
      byKey.set(key, { directory: slash > 0 ? track.id.slice(0, slash) : '', tracks: [track] });
    } else if (bucket.tracks.length < limit) {
      bucket.tracks.push(track);
    }
  }
  if (byKey.size === 0) return new Map();

  // Nell'ordine della Home; una cartella che la Home non conosce (non dovrebbe succedere: stesso
  // elenco) va in coda con un titolo calcolato da sé.
  const titles = new Map(folders.map((folder) => [folder.key, folder.title] as const));
  const order = new Map(folders.map((folder, index) => [folder.key, index] as const));
  const keys = [...byKey.keys()].sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
  );

  const ids = keys.map((key) => idOf(key));
  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);

  const sections = new Map<string, FeaturedSectionGroup>();
  for (const [index, key] of keys.entries()) {
    const id = ids[index];
    const bucket = byKey.get(key);
    if (!id || !bucket || bucket.tracks.length === 0 || seen.get(id) !== 1) continue;
    sections.set(id, {
      id,
      key,
      title:
        titles.get(key) ??
        (sectionTitleFromDirectory(bucket.directory) || HOME_TRACKS_DEFAULT_SECTION),
      tracks: bucket.tracks,
    });
  }
  return sections;
}
