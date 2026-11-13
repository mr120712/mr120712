// @polsia:user-owned — pagina "Statistiche di ascolto" (richiede login, come tutta l'app).
import type { Metadata } from 'next';
import { ListeningStatsView } from '@/components/custom/music/listening-stats-view';
import styles from './statistiche.module.css';

export const metadata: Metadata = {
  title: 'Statistiche di ascolto',
  description: 'I tuoi ascolti su Solco: brani, minuti, artisti e fonti preferite.',
  alternates: { canonical: '/statistiche' },
};

export default function StatistichePage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>LE TUE STATISTICHE</p>
        <h1 className={styles.title}>Statistiche di ascolto</h1>
        <p className={styles.lead}>Un riepilogo di cosa hai ascoltato su Solco.</p>
      </header>
      <ListeningStatsView />
    </main>
  );
}
