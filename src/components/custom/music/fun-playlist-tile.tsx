// @polsia:user-owned — le playlist divertenti «di casa» di Solco (genre-catalog.ts, famiglia
// «divertenti»): un riquadro con la copertina disegnata, il nome e una riga di descrizione, la riga
// scorrevole per la Home e la Libreria, la griglia per /generi. Niente stato né richieste: i dati
// sono nel server (il catalogo) e il componente funziona anche nelle pagine server.

import Link from 'next/link';
import { PlaylistCover } from '@/components/custom/music/playlist-cover';
import { funPlaylists, type GenreEntry } from '@/lib/music/genre-catalog';
import styles from './fun-playlists.module.css';

/** Una playlist divertente del catalogo: ha sempre la copertina. */
export type FunPlaylist = GenreEntry & { cover: NonNullable<GenreEntry['cover']> };

export function isFunPlaylist(entry: GenreEntry): entry is FunPlaylist {
  return entry.family === 'divertenti' && entry.cover !== undefined;
}

export function funPlaylistPath(entry: Pick<GenreEntry, 'slug'>) {
  return `/generi/${entry.slug}`;
}

export function FunPlaylistTile({ playlist }: { playlist: FunPlaylist }) {
  return (
    <Link
      href={funPlaylistPath(playlist)}
      className={styles.tile}
      aria-label={`Apri la playlist ${playlist.name}`}
      title={playlist.description}
    >
      <span className={styles.cover}>
        <PlaylistCover cover={playlist.cover} />
      </span>
      <span className={styles.name}>{playlist.name}</span>
      <span className={styles.blurb}>{playlist.description}</span>
    </Link>
  );
}

/** Griglia completa (pagina /generi). */
export function FunPlaylistGrid({
  playlists = funPlaylists.filter(isFunPlaylist),
}: {
  playlists?: readonly FunPlaylist[];
}) {
  return (
    <ul className={styles.grid}>
      {playlists.map((playlist) => (
        <li key={playlist.slug}>
          <FunPlaylistTile playlist={playlist} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Riga scorrevole con tutte le playlist divertenti (Home e scheda Playlist della Libreria).
 * `headingLevel` 3 dentro una scheda che ha già il suo h2.
 */
export function FunPlaylistsRow({
  id = 'playlist-divertenti',
  title = 'Playlist divertenti',
  eyebrow = 'PLAYLIST DI SOLCO',
  note = 'Pronte nel server, una per ogni situazione: scegli la copertina e premi play.',
  headingLevel = 2,
  playlists = funPlaylists.filter(isFunPlaylist),
}: {
  id?: string;
  title?: string;
  eyebrow?: string;
  note?: string | null;
  headingLevel?: 2 | 3;
  playlists?: readonly FunPlaylist[];
}) {
  const headingId = `${id}-heading`;
  const heading =
    headingLevel === 2 ? <h2 id={headingId}>{title}</h2> : <h3 id={headingId}>{title}</h3>;
  return (
    <section className={styles.section} id={id} aria-labelledby={headingId}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{eyebrow}</p>
          {heading}
        </div>
        <Link href="/generi">Tutte le playlist</Link>
      </header>
      <ul className={styles.rail}>
        {playlists.map((playlist) => (
          <li key={playlist.slug}>
            <FunPlaylistTile playlist={playlist} />
          </li>
        ))}
      </ul>
      {note ? <p className={styles.note}>{note}</p> : null}
    </section>
  );
}
