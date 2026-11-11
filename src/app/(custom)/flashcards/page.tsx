// @polsia:user-owned
import type { Metadata } from 'next';
import styles from '@/components/custom/music/discover.module.css';
import { FlashcardsView } from '@/components/custom/music/flashcards-view';

export const metadata: Metadata = {
  title: 'Flashcard musicali',
  description:
    'Impara la musica con le flashcard di Solco: generi, teoria, storia e i brani che ascolti.',
  alternates: { canonical: '/flashcards' },
};

export default function FlashcardsPage() {
  return (
    <main className={styles.page}>
      <header>
        <p className={styles.eyebrow}>IMPARA GIOCANDO</p>
        <h1 className={styles.pageTitle}>Flashcard musicali</h1>
        <p className={styles.lead}>
          Gira la carta, poi dimmi se lo sapevi: le carte da ripassare tornano più spesso.
        </p>
      </header>
      <FlashcardsView />
    </main>
  );
}
