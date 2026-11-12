// @polsia:user-owned — anteprima in Home della libreria PUBBLICA: i primi brani caricati dagli
// utenti, con link alla pagina completa /pubblica.
'use client';

import Link from 'next/link';
import { PublicUploadsChart } from '@/components/custom/music/public-uploads-chart';
import styles from './public-uploads-home-section.module.css';

export function PublicUploadsHomeSection() {
  return (
    <section
      id="community-uploads"
      className={styles.section}
      aria-labelledby="community-uploads-heading"
    >
      <div className={styles.head}>
        <div>
          <p className={styles.eyebrow}>LIBRERIA PUBBLICA</p>
          <h2 id="community-uploads-heading" className={styles.title}>
            Brani della community
          </h2>
        </div>
        <Link href="/pubblica" className={styles.link}>
          Vedi tutti
        </Link>
      </div>
      <PublicUploadsChart limit={5} />
    </section>
  );
}
