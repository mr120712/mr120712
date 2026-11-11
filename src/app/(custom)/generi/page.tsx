// @polsia:user-owned — tutti i generi (anche underground) e le playlist Solco.
import type { Metadata } from 'next';
import Link from 'next/link';
import { genreCatalog, genreFamilies } from '@/lib/music/genre-catalog';
import styles from './generi.module.css';

export const metadata: Metadata = {
  title: 'Generi e playlist',
  description:
    'Tutti i generi su Solco, dall’underground al mainstream: rap, techno, drum and bass, post-punk, metal, ambient e playlist a tema.',
  alternates: { canonical: '/generi' },
};

export default function GenresPage() {
  return (
    <main className={styles.page}>
      <header>
        <h1>Generi e playlist</h1>
        <p className={styles.lead}>
          Dall’underground al club: scegli un genere per ascoltare brani, radio e catalogo globale.
        </p>
      </header>
      {genreFamilies.map((family) => {
        const entries = genreCatalog.filter((entry) => entry.family === family.id);
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
