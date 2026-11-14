// @polsia:user-owned — sezione «Le tue playlist» della pagina Cerca: le raccolte dell'ascoltatore
// (playlist e Preferiti) e i brani salvati che corrispondono alla ricerca, visibili solo a lui (li
// manda GET /api/music/library/search, privato). Ogni raccolta apre la Libreria su quella raccolta
// (/library?playlist=<id>); ogni brano suona ESATTAMENTE come nella Libreria: stessa conversione
// (collectionItemToTrack / collectionQueue) e stesso avvio (playCollectionItem), con in coda i brani
// trovati, come le altre code della ricerca.
'use client';

import { Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo } from 'react';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import {
  collectionItemToTrack,
  collectionQueue,
  isCollectionItemCurrent,
  playCollectionItem,
} from '@/components/custom/music/collection-tracks';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { PlaylistMosaic } from '@/components/custom/music/playlist-mosaic';
import type {
  LibrarySearchCollection,
  LibrarySearchResponse,
  LibrarySearchTrack,
} from '@/lib/contracts/library-search';
import { libraryPlaylistPath } from '@/lib/music/library-links';
import discover from './discover.module.css';
import styles from './library-search-results.module.css';
import searchStyles from './unified-search-results.module.css';

type CollectionKind = LibrarySearchCollection['kind'];

/** Raccolte e brani trovati: il numero che conta il chip «Le tue». */
export function librarySearchCount(result: LibrarySearchResponse | null): number {
  return result ? result.collections.length + result.tracks.length : 0;
}

function trackCount(count: number) {
  return count === 1 ? '1 brano' : `${count} brani`;
}

function otherCollections(count: number) {
  if (count <= 0) return '';
  return count === 1 ? ' e in un’altra raccolta' : ` e in altre ${count} raccolte`;
}

function KindBadge({ kind }: { kind: CollectionKind }) {
  return (
    <span className={searchStyles.badge} data-source={kind === 'favorites' ? 'favorites' : 'mine'}>
      {kind === 'favorites' ? 'Preferiti' : 'La tua playlist'}
    </span>
  );
}

function CollectionCard({ collection }: { collection: LibrarySearchCollection }) {
  // Il mosaico riceve le copertine come elementi: stessa composizione della Libreria.
  const items = useMemo(
    () => collection.covers.map((artworkUrl) => ({ artworkUrl })),
    [collection.covers],
  );
  return (
    <li className={styles.card} data-kind={collection.kind}>
      <div className={styles.cover}>
        <PlaylistMosaic name={collection.name} items={items} />
      </div>
      <div className={styles.cardCopy}>
        <KindBadge kind={collection.kind} />
        {/* Il link è il nome; il suo ::after rende cliccabile tutta la scheda. */}
        <Link href={libraryPlaylistPath(collection.id)} className={styles.cardLink} dir="auto">
          {collection.name}
          <span className="sr-only">, apri nella Libreria</span>
        </Link>
        <span className={styles.meta}>{trackCount(collection.itemCount)}</span>
        {collection.description ? (
          <p className={styles.description} dir="auto">
            {collection.description}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function TrackRow({
  track,
  playing,
  onPlay,
}: {
  track: LibrarySearchTrack;
  playing: boolean;
  onPlay: () => void;
}) {
  // Come nella Libreria: un elemento senza metadati completi resta visibile ma non si avvia.
  const playable = collectionItemToTrack(track) !== null;
  const where =
    track.collectionKind === 'favorites'
      ? 'dai tuoi Preferiti'
      : `dalla tua playlist ${track.collectionName}`;
  return (
    <li className={discover.row} data-kind="library">
      <div className={discover.rowArt}>
        <FallbackArt src={track.artworkUrl} label={track.title} size={104} />
      </div>
      <div className={searchStyles.copy}>
        {/* Su telefono il distintivo sale sopra il titolo e il sottotitolo va a capo (CSS). */}
        <div className={`${searchStyles.titleLine} ${styles.trackTitleLine}`}>
          <KindBadge kind={track.collectionKind} />
          <strong className={`${searchStyles.title} ${styles.trackTitle}`} title={track.title}>
            {track.title}
          </strong>
        </div>
        <span className={`${searchStyles.sub} ${styles.trackSub}`}>
          {track.creatorName ? `${track.creatorName} · ` : null}in{' '}
          <Link
            href={libraryPlaylistPath(track.collectionId)}
            className={styles.inlineLink}
            dir="auto"
          >
            {track.collectionName}
          </Link>
          {otherCollections(track.otherCollectionCount)}
        </span>
        {track.source === 'audius' && track.creatorName && track.sourceUrl ? (
          // Licenza OML §1.5 come nella Libreria e nelle altre righe Audius della ricerca: copyright
          // («© <artista>»), link alla licenza e al brano. Un brano Audius non suona senza
          // attribuzione; si salvano solo brani OML e lo stream ricontrolla la licenza a ogni ascolto.
          <AudiusLicenseNotice
            track={{
              license: null,
              copyrightNotice: null,
              licensorName: track.creatorName,
              attributionRemovalRequested: false,
              title: track.title,
              trackUrl: track.sourceUrl,
            }}
            showTrackLink
          />
        ) : null}
      </div>
      <div className={discover.rowActions}>
        {playable ? (
          <button
            type="button"
            className={`${discover.iconButton} ${discover.playButton}`}
            onClick={onPlay}
            aria-label={`${playing ? 'Metti in pausa' : 'Riproduci'} ${track.title} ${where}`}
          >
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function LibrarySearchResults({ result }: { result: LibrarySearchResponse }) {
  const player = useMusicPlayer();
  const headingId = useId();
  const tracksHeadingId = useId();
  // La coda sono i brani trovati, nell'ordine mostrato: «successivo» resta in questo elenco.
  const queue = useMemo(() => collectionQueue(result.tracks), [result.tracks]);
  const isPlayingNow = (track: LibrarySearchTrack) =>
    isCollectionItemCurrent(player, track) &&
    (player.status === 'playing' || player.status === 'loading');

  return (
    <section className={styles.section} aria-labelledby={headingId} data-section="library">
      <header className={styles.header}>
        <h3 id={headingId}>Le tue playlist</h3>
        <p className={styles.note}>Dalla tua Libreria: solo tu vedi questi risultati.</p>
      </header>

      {result.collections.length ? (
        <ul className={styles.cards} aria-label="Raccolte trovate">
          {result.collections.map((collection) => (
            <CollectionCard key={collection.id} collection={collection} />
          ))}
        </ul>
      ) : null}

      {result.tracks.length ? (
        <>
          <h4 id={tracksHeadingId} className={styles.subheading}>
            Nei tuoi brani
          </h4>
          <ol className={discover.list} aria-labelledby={tracksHeadingId}>
            {result.tracks.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                playing={isPlayingNow(track)}
                onPlay={() => playCollectionItem(player, track, queue)}
              />
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
