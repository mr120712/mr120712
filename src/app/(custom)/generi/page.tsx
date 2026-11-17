// @polsia:user-owned — tutti i generi (anche underground), le playlist Solco a tema e le playlist
// divertenti con la copertina disegnata.
import type { Metadata } from 'next';
import Link from 'next/link';
import { FunPlaylistGrid, isFunPlaylist } from '@/components/custom/music/fun-playlist-tile';
import { genreCatalog, genreFamilies } from '@/lib/music/genre-catalog';
import styles from './generi.module.css';

export const metadata: Metadata = {
  title: 'Generi e playlist',
  description:
    'Tutti i generi su Solco, dall’underground al mainstream: rap, techno, drum and bass, post-punk, metal, ambient, playlist a tema e playlist divertenti come «Piede comodino».',
  alternates: { canonical: '/generi' },
};

export default function GenresPage() {
  return (
    <main className={styles.page}>
      <header>
        <h1>Generi e playlist</h1>
        <p className={styles.lead}>
          Dall’underground al club: scegli un genere per ascoltare brani e radio, o una playlist
          divertente per la situazione del momento.
        </p>
      </header>
      {genreFamilies.map((family) => {
        const entries = genreCatalog.filter((entry) => entry.family === family.id);
        if (family.id === 'divertenti') {
          return (
            <section key={family.id} className={styles.family} aria-labelledby={`fam-${family.id}`}>
              <h2 id={`fam-${family.id}`}>{family.label}</h2>
              <p className={styles.lead}>
                Pronte nel server, con la copertina giusta: una per ogni situazione di tutti i
                giorni.
              </p>
              <FunPlaylistGrid playlists={entries.filter(isFunPlaylist)} />
            </section>
          );
        }
        return (
          <section key={family.id} className={styles.family} aria-labelledby={`fam-${family.id}`}>
            <h2 id={`fam-${family.id}`}>{family.label}</h2>
            <ul className={family.id === 'playlist' ? styles.playlistGrid : styles.grid}>
              {entries.map((entry) => (
                <li key={entry.slug}>
                  <Link href={`/generi/${entry.slug}`}>
                    <strong>{entry.name}</strong>
                    {family.id === 'playlist' ? <span>{entry.description}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}
