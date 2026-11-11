// @polsia:user-owned
import Image from 'next/image';
import type {
  AudiusAlbumSearchResult,
  AudiusArtistSearchResult,
  AudiusPlaylistSearchResult,
} from '@/lib/contracts/music';
import styles from './catalog-cards.module.css';

export function AudiusReleaseCard({ release }: { release: AudiusAlbumSearchResult }) {
  return (
    <article className={styles.card}>
      <a
        className={styles.artwork}
        href={release.albumUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={`Apri ${release.title} su Audius`}
      >
        {release.artworkUrl ? (
          <Image
            src={release.artworkUrl}
            alt={`Copertina di ${release.title}`}
            width={240}
            height={240}
            unoptimized
          />
        ) : (
          <span className={styles.noArtwork}>Copertina non disponibile</span>
        )}
      </a>
      <div className={styles.copy}>
        <span className={styles.source}>Nuova uscita · Audius</span>
        <a className={styles.title} href={release.albumUrl} target="_blank" rel="noreferrer">
          {release.title}
        </a>
        {release.artistName ? (
          release.artistUrl ? (
            <a className={styles.creator} href={release.artistUrl} target="_blank" rel="noreferrer">
              {release.artistName} · Profilo Audius
            </a>
          ) : (
            <span className={styles.creator}>{release.artistName}</span>
          )
        ) : null}
        {release.trackCount !== null ? <small>{release.trackCount} brani</small> : null}
      </div>
    </article>
  );
}

export function AudiusPlaylistCard({ playlist }: { playlist: AudiusPlaylistSearchResult }) {
  return (
    <article className={styles.card}>
      <a
        className={styles.artwork}
        href={playlist.playlistUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={`Apri la playlist ${playlist.title} su Audius`}
      >
        <Image
          src={playlist.artworkUrl}
          alt={`Copertina della playlist ${playlist.title}`}
          width={240}
          height={240}
          unoptimized
        />
      </a>
      <div className={styles.copy}>
        <span className={styles.source}>Playlist · Audius</span>
        <a className={styles.title} href={playlist.playlistUrl} target="_blank" rel="noreferrer">
          {playlist.title}
        </a>
        <a className={styles.creator} href={playlist.artistUrl} target="_blank" rel="noreferrer">
          {playlist.artistName} · Profilo Audius
        </a>
        {playlist.trackCount !== null ? <small>{playlist.trackCount} brani</small> : null}
      </div>
    </article>
  );
}

export function AudiusArtistCard({ artist }: { artist: AudiusArtistSearchResult }) {
  return (
    <a className={styles.artistCard} href={artist.profileUrl} target="_blank" rel="noreferrer">
      <span className={styles.artistArtwork}>
        <Image
          src={artist.artworkUrl}
          alt={`Profilo di ${artist.name}`}
          width={176}
          height={176}
          unoptimized
        />
      </span>
      <span className={styles.artistCopy}>
        <span className={styles.source}>Artista · Audius</span>
        <strong>{artist.name}</strong>
        <span>Apri il profilo Audius</span>
      </span>
    </a>
  );
}
