// @polsia:user-owned
import Image from 'next/image';
import Link from 'next/link';
import type { AudiusAlbumSearchResult } from '@/lib/contracts/music';
import styles from './album-card.module.css';

export function AlbumCard({ album }: { album: AudiusAlbumSearchResult }) {
  return (
    <Link className={styles.card} href={`/albums/${encodeURIComponent(album.id)}`}>
      <span className={styles.artwork}>
        {album.artworkUrl ? (
          <Image
            src={album.artworkUrl}
            alt={`Copertina di ${album.title}`}
            width={160}
            height={160}
            unoptimized
          />
        ) : (
          <span aria-hidden="true">S</span>
        )}
      </span>
      <span className={styles.copy}>
        <span className={styles.source}>Album · Audius</span>
        <strong>{album.title}</strong>
        <span>{album.artistName ?? 'Artista non indicato da Audius'}</span>
        {album.trackCount !== null ? <small>{album.trackCount} brani nel catalogo</small> : null}
      </span>
    </Link>
  );
}
