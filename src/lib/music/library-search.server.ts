// @polsia:user-owned — ricerca nella Libreria di UN ascoltatore: le sue raccolte (playlist e
// Preferiti) per nome o descrizione, e i brani salvati nelle sue raccolte per titolo o artista.
// Ogni query filtra per userId: nessuna riga di un altro account può entrare nel risultato.
//
// Perché il confronto è in TypeScript e non con ILIKE in Postgres: ILIKE ignora maiuscole e
// minuscole ma NON gli accenti (senza l'estensione unaccent, che `prisma db push` non installa),
// e in italiano chi scrive «perche» deve trovare «Perché». Qui si usa lo stesso normalizeText /
// relevanceScore della ricerca unificata (minuscolo, senza accenti, uguale > inizia con > contiene),
// quindi la Libreria e le altre fonti concordano; per i brani trackRelevance aggiunge, come per i
// brani in evidenza, la forma «Artista Titolo» dei link di condivisione. Il costo resta limitato: le raccolte sono al
// massimo MAX_PLAYLISTS_PER_USER + Preferiti; dei brani si leggono solo le colonne che servono al
// confronto, i più recenti fino a LIBRARY_SEARCH_ITEM_SCAN_LIMIT, e solo per i 10 scelti si leggono
// tutti i campi del player. Lettura soltanto: niente scritture a ogni tasto (i metadati YouTube
// scaduti si tolgono in lettura con withoutExpiredYouTubeMetadata, PRIMA del confronto).
import 'server-only';
import {
  LIBRARY_SEARCH_COLLECTION_LIMIT,
  LIBRARY_SEARCH_COVER_LIMIT,
  LIBRARY_SEARCH_TRACK_LIMIT,
  type LibrarySearchCollection,
  LibrarySearchCollectionSchema,
  LibrarySearchCoverSchema,
  type LibrarySearchTrack,
  LibrarySearchTrackSchema,
} from '@/lib/contracts/library-search';
import { prisma } from '@/lib/db';
import {
  MAX_ITEMS_PER_COLLECTION,
  MAX_PLAYLISTS_PER_USER,
  withoutExpiredYouTubeMetadata,
} from '@/lib/music/collections.server';
import { normalizePlaylistDescription } from '@/lib/music/playlist-share';
import { normalizeText, relevanceScore, trackRelevance } from '@/lib/music/unified-search';

/** Raccolte lette: più del massimo consentito (100 playlist + Preferiti), mai senza tetto. */
export const LIBRARY_SEARCH_COLLECTION_SCAN_LIMIT = MAX_PLAYLISTS_PER_USER * 2;
/**
 * Brani confrontati: i più recenti fino a questo numero (10 raccolte piene). Le raccolte si
 * confrontano sempre tutte; oltre questa soglia un brano salvato da molto tempo può non comparire.
 */
export const LIBRARY_SEARCH_ITEM_SCAN_LIMIT = MAX_ITEMS_PER_COLLECTION * 10;
/** Elementi con copertina letti per il mosaico di una raccolta trovata (ne servono 4 diversi). */
const COVER_SCAN_PER_COLLECTION = 24;
/** Una corrispondenza nella sola descrizione vale meno di una nel nome («contiene» = 40). */
const DESCRIPTION_SCORE = 30;

/** Ordine della Libreria: più recenti prima, con l'id come spareggio stabile. */
const LIBRARY_ITEM_ORDER = [{ createdAt: 'desc' as const }, { id: 'asc' as const }];

export type LibrarySearchResult = {
  collections: LibrarySearchCollection[];
  tracks: LibrarySearchTrack[];
};

type CollectionRow = {
  id: string;
  name: string;
  kind: string;
  description: string | null;
};

/** Solo le playlist hanno una descrizione, ripulita come nella Libreria. */
function collectionDescription(row: CollectionRow): string | null {
  return row.kind === 'playlist' ? normalizePlaylistDescription(row.description) : null;
}

/** Rilevanza di una raccolta: il nome come la ricerca unificata, poi la descrizione. */
function collectionScore(row: CollectionRow, query: string): number {
  const byName = relevanceScore([row.name], query);
  if (byName > 0) return byName;
  const needle = normalizeText(query);
  const description = collectionDescription(row);
  return needle && description && normalizeText(description).includes(needle)
    ? DESCRIPTION_SCORE
    : 0;
}

/**
 * Le prime copertine diverse nell'ordine della Libreria, come playlistMosaicCovers, saltando i
 * metadati YouTube scaduti e gli indirizzi che il contratto non accetta.
 */
function mosaicCovers(
  items: ReadonlyArray<{ source: string; expiresAt: Date | null; artworkUrl: string | null }>,
  now: Date,
): string[] {
  const covers: string[] = [];
  for (const raw of items) {
    if (covers.length >= LIBRARY_SEARCH_COVER_LIMIT) break;
    const url = withoutExpiredYouTubeMetadata(raw, now).artworkUrl?.trim();
    if (!url || covers.includes(url)) continue;
    if (LibrarySearchCoverSchema.safeParse(url).success) covers.push(url);
  }
  return covers;
}

type TrackMatch = {
  itemId: string;
  score: number;
  createdAt: Date;
  collectionIds: Set<string>;
};

/**
 * Le raccolte e i brani dell'ascoltatore `userId` che corrispondono a `query` (già ripulita e
 * validata dalla route). Al massimo LIBRARY_SEARCH_COLLECTION_LIMIT raccolte e
 * LIBRARY_SEARCH_TRACK_LIMIT brani, i più rilevanti prima.
 */
export async function searchUserLibrary(
  userId: string,
  query: string,
  now = new Date(),
): Promise<LibrarySearchResult> {
  const [collectionRows, itemRows] = await Promise.all([
    prisma.userMusicCollection.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        kind: true,
        description: true,
        _count: { select: { items: true } },
      },
      // L'ordine della Libreria (Preferiti, poi le playlist dalla più vecchia): spareggio stabile.
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      take: LIBRARY_SEARCH_COLLECTION_SCAN_LIMIT,
    }),
    prisma.userMusicCollectionItem.findMany({
      // Un elemento senza titolo (metadati YouTube già rimossi) non può corrispondere.
      where: { collection: { userId }, title: { not: null } },
      select: {
        id: true,
        collectionId: true,
        source: true,
        sourceId: true,
        title: true,
        creatorName: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: LIBRARY_ITEM_ORDER,
      take: LIBRARY_SEARCH_ITEM_SCAN_LIMIT,
    }),
  ]);

  const collectionsById = new Map(collectionRows.map((row) => [row.id, row]));

  const matchedCollections = collectionRows
    .map((row, index) => ({ row, index, score: collectionScore(row, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, LIBRARY_SEARCH_COLLECTION_LIMIT);

  // Un brano presente in più raccolte compare una volta sola: resta l'occorrenza più rilevante (a
  // parità, la più recente, perché le righe arrivano dalla più recente) e si contano le altre.
  const matches = new Map<string, TrackMatch>();
  for (const raw of itemRows) {
    if (!collectionsById.has(raw.collectionId)) continue;
    // Metadati YouTube oltre la conservazione: tolti PRIMA del confronto, mai usati.
    const item = withoutExpiredYouTubeMetadata(raw, now);
    if (!item.title) continue;
    // Anche "Artista Titolo" (la query dei link di condivisione di un brano), come i brani in evidenza.
    const score = trackRelevance({ title: item.title, artist: item.creatorName }, query);
    if (score <= 0) continue;
    const key = `${item.source}:${item.sourceId}`;
    const current = matches.get(key);
    if (!current) {
      matches.set(key, {
        itemId: item.id,
        score,
        createdAt: item.createdAt,
        collectionIds: new Set([item.collectionId]),
      });
      continue;
    }
    current.collectionIds.add(item.collectionId);
    if (score > current.score) {
      current.itemId = item.id;
      current.score = score;
      current.createdAt = item.createdAt;
    }
  }
  const chosenTracks = [...matches.values()]
    .sort(
      (left, right) =>
        right.score - left.score || right.createdAt.getTime() - left.createdAt.getTime(),
    )
    .slice(0, LIBRARY_SEARCH_TRACK_LIMIT);

  const matchedIds = matchedCollections.map((entry) => entry.row.id);
  const chosenIds = chosenTracks.map((entry) => entry.itemId);
  const [coverRows, trackRows] = await Promise.all([
    matchedIds.length
      ? prisma.userMusicCollection.findMany({
          where: { userId, id: { in: matchedIds } },
          select: {
            id: true,
            items: {
              where: { artworkUrl: { not: null } },
              select: { source: true, expiresAt: true, artworkUrl: true },
              orderBy: LIBRARY_ITEM_ORDER,
              take: COVER_SCAN_PER_COLLECTION,
            },
          },
        })
      : Promise.resolve([]),
    chosenIds.length
      ? prisma.userMusicCollectionItem.findMany({
          where: { id: { in: chosenIds }, collection: { userId } },
          select: {
            id: true,
            collectionId: true,
            source: true,
            sourceId: true,
            title: true,
            creatorName: true,
            artworkUrl: true,
            sourceUrl: true,
            artistUrl: true,
            durationSeconds: true,
            expiresAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const coversById = new Map(coverRows.map((row) => [row.id, mosaicCovers(row.items, now)]));
  const collections = matchedCollections.flatMap(({ row }) => {
    const parsed = LibrarySearchCollectionSchema.safeParse({
      id: row.id,
      name: row.name,
      kind: row.kind,
      description: collectionDescription(row),
      itemCount: row._count.items,
      covers: coversById.get(row.id) ?? [],
    });
    // Una riga anomala (tipo sconosciuto) non fa fallire la ricerca: si salta.
    return parsed.success ? [parsed.data] : [];
  });

  const fullById = new Map(trackRows.map((row) => [row.id, row]));
  const tracks = chosenTracks.flatMap((match) => {
    const row = fullById.get(match.itemId);
    const collection = row ? collectionsById.get(row.collectionId) : undefined;
    if (!row || !collection) return [];
    const item = withoutExpiredYouTubeMetadata(row, now);
    const parsed = LibrarySearchTrackSchema.safeParse({
      id: item.id,
      source: item.source,
      sourceId: item.sourceId,
      title: item.title,
      creatorName: item.creatorName,
      artworkUrl: item.artworkUrl,
      sourceUrl: item.sourceUrl,
      artistUrl: item.artistUrl,
      durationSeconds: item.durationSeconds,
      collectionId: collection.id,
      collectionName: collection.name,
      collectionKind: collection.kind,
      otherCollectionCount: match.collectionIds.size - 1,
    });
    return parsed.success ? [parsed.data] : [];
  });

  return { collections, tracks };
}
