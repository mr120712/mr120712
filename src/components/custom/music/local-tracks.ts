// @polsia:user-owned — i brani di "La tua musica" (file dell'ascoltatore) nel player condiviso.
//
// Design legale: i file e i loro tag non lasciano mai il dispositivo. Nel player un brano locale ha
// qualifiedId 'local:<id>' (l'id casuale della libreria, mai derivato dal file) e playbackMode
// 'local': suona da un object URL del Blob salvato in IndexedDB, senza permessi, contatore Free,
// accesso, cronologia, premi o precaricamenti dal server, e non finisce mai in playlist o Preferiti.
//
// La coda salvata nel browser (localStorage) tiene di un brano locale solo l'id: titolo, artista e
// album si rileggono da IndexedDB al ripristino, così "Rimuovi" nella libreria li cancella davvero
// dal dispositivo; un brano che non c'è più si toglie dalla coda.
import type { MusicPlayerTrack } from '@/components/custom/music/music-player';
import { type LocalTrack, localTrackAttribution, localTrackSource } from '@/lib/local-music';

export const LOCAL_SOURCE_LABEL = 'La tua musica';

export const LOCAL_MISSING_MESSAGE =
  'Il file non è più su questo dispositivo: aggiungilo di nuovo da La tua musica.';

export const LOCAL_UNAVAILABLE_MESSAGE =
  'La tua musica non si riesce a leggere in questo browser. Riprova tra poco.';

export const LOCAL_UNPLAYABLE_MESSAGE =
  'Questo file non si riesce a riprodurre su questo dispositivo.';

const LOCAL_QUALIFIED_ID = /^local:([A-Za-z0-9_-]{1,128})$/;

/** Id della libreria per 'local:<id>', oppure null. */
export function localTrackId(qualifiedId: string): string | null {
  return LOCAL_QUALIFIED_ID.exec(qualifiedId)?.[1] ?? null;
}

/** Vero per un brano della libreria sul dispositivo con un id valido. */
export function isLocalTrack(
  track: Pick<MusicPlayerTrack, 'playbackMode' | 'qualifiedId'> | null | undefined,
): boolean {
  return track?.playbackMode === 'local' && localTrackId(track.qualifiedId) !== null;
}

/** Etichetta "Ascolta altrove" per un brano scaricato, in base alla fonte. */
function downloadSourceLinkLabel(source: 'audius-download' | 'podcast-download'): string {
  return source === 'audius-download' ? 'Brano su Audius' : 'Episodio originale';
}

/**
 * Brano del player per un file della libreria. La copertina la crea il player (object URL che
 * revoca lui): qui artworkUrl resta null. Uso: `player.playTrack(track, '', queue)`.
 *
 * I file locali mantengono la forma storica (fonte "La tua musica", nessun link). I brani SCARICATI
 * ("Scarica il permesso") portano invece la loro attribuzione nel player: fonte leggibile, link al
 * brano/episodio originale e, per Audius, la Open Music License fra i crediti. Resta playbackMode
 * 'local': si riproducono dal dispositivo, offline, senza nessuna richiesta al server.
 */
export function localTrackToPlayerTrack(track: LocalTrack): MusicPlayerTrack {
  const source = localTrackSource(track);
  if (source === 'local') {
    return {
      qualifiedId: `local:${track.id}`,
      title: track.title,
      artistName: track.artist ?? '',
      album: track.album,
      artworkUrl: null,
      sourceLabel: LOCAL_SOURCE_LABEL,
      sourceUrl: null,
      durationSeconds: track.durationSeconds,
      playbackMode: 'local',
    };
  }
  const attribution = localTrackAttribution(track);
  return {
    qualifiedId: `local:${track.id}`,
    title: track.title,
    artistName: track.artist ?? '',
    album: track.album,
    artworkUrl: null,
    sourceLabel: attribution?.sourceName ?? (source === 'audius-download' ? 'Audius' : 'Podcast'),
    sourceUrl: attribution?.sourceUrl ?? null,
    sourceUrlLabel: attribution?.sourceUrl ? downloadSourceLinkLabel(source) : undefined,
    durationSeconds: track.durationSeconds,
    playbackMode: 'local',
    credits: attribution?.licenseName ? [`Licenza: ${attribution.licenseName}`] : undefined,
  };
}

/** Quello che la coda salvata nel browser tiene di un elemento: di un brano locale solo l'id. */
export function persistedQueueItem(item: MusicPlayerTrack): MusicPlayerTrack {
  if (item.playbackMode !== 'local') return item;
  return {
    qualifiedId: item.qualifiedId,
    title: '',
    artistName: '',
    sourceLabel: LOCAL_SOURCE_LABEL,
    sourceUrl: null,
    playbackMode: 'local',
  };
}

export type RestoredQueue = {
  items: MusicPlayerTrack[];
  index: number;
  /** false: il brano corrente non c'è più, si riparte dal successivo e dall'inizio. */
  sameTrack: boolean;
};

/**
 * Coda salvata con i brani locali riletti dalla libreria (titolo, artista, album, durata). Quelli
 * che non ci sono più (rimossi, spazio liberato dal browser, libreria non disponibile) si tolgono.
 * Se tocca al brano corrente, riparte l'elemento che lo seguiva. null: non resta niente.
 */
export async function restoreLocalItems(
  items: readonly MusicPlayerTrack[],
  index: number,
  readTrack: (id: string) => Promise<LocalTrack | null>,
): Promise<RestoredQueue | null> {
  const ids = [
    ...new Set(
      items
        .filter((item) => item?.playbackMode === 'local')
        .map((item) => localTrackId(item.qualifiedId))
        .filter((id): id is string => id !== null),
    ),
  ];
  const found = new Map<string, LocalTrack>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const track = await readTrack(id);
        if (track && track.id === id) found.set(id, track);
      } catch {
        // Library unavailable: the item is dropped like a missing one.
      }
    }),
  );
  const restored: MusicPlayerTrack[] = [];
  let restoredIndex = -1;
  let sameTrack = false;
  items.forEach((item, position) => {
    let kept: MusicPlayerTrack | null = item ?? null;
    if (item?.playbackMode === 'local') {
      const id = localTrackId(item.qualifiedId);
      const track = id ? found.get(id) : undefined;
      kept = track ? localTrackToPlayerTrack(track) : null;
    }
    if (position === index) {
      restoredIndex = restored.length;
      sameTrack = kept !== null;
    }
    if (kept) restored.push(kept);
  });
  if (restored.length === 0 || restoredIndex < 0) return null;
  // The current item is gone and was the last one: back to the start of the queue.
  if (restoredIndex >= restored.length) restoredIndex = 0;
  return { items: restored, index: restoredIndex, sameTrack };
}
