// @polsia:user-owned — anteprima in Home della classifica della community: i brani caricati dagli
// utenti più ascoltati (un ascolto al giorno per persona), con link alla pagina completa /pubblica.
'use client';

import Link from 'next/link';
import {
  COMMUNITY_CHART_TITLE,
  CommunityChartTitle,
  PublicUploadsChart,
} from '@/components/custom/music/public-uploads-chart';
import { Button } from '@/components/ui/button';
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
          <p className={styles.eyebrow}>CLASSIFICA DELLA COMMUNITY</p>
          <h2 id="community-uploads-heading" className={styles.title}>
            <CommunityChartTitle />
          </h2>
        </div>
        {/* L'etichetta accessibile comincia con il testo visibile (WCAG 2.5.3). */}
        <Button asChild variant="link" size="sm" className={styles.link}>
          <Link href="/pubblica" aria-label={`Vedi tutti i ${COMMUNITY_CHART_TITLE.toLowerCase()}`}>
            Vedi tutti
          </Link>
        </Button>
      </div>
      <PublicUploadsChart limit={5} />
    </section>
  );
}
