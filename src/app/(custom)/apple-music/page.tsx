// @polsia:user-owned
import type { Metadata } from 'next';
import { AppleMusicView } from '@/components/custom/music/apple-music-view';
import styles from '@/components/custom/music/discover.module.css';

export const metadata: Metadata = {
  title: 'Apple Music',
  description:
    'Collega Apple Music e ascolta l’intero catalogo nel player di Solco con il tuo abbonamento Apple.',
  alternates: { canonical: '/apple-music' },
};

export default function AppleMusicPage() {
  return (
    <main className={styles.page}>
      <header>
        <p className={styles.eyebrow}>IL TUO ABBONAMENTO, IL PLAYER DI SOLCO</p>
        <h1 className={styles.pageTitle}>Apple Music</h1>
      </header>
      <AppleMusicView />
    </main>
  );
}
