// @polsia:user-owned — pagina della libreria PUBBLICA: form di caricamento (per i loggati) +
// classifica dei brani caricati dagli utenti, ascoltabile da tutti.
'use client';

import { useState } from 'react';
import { PublicUploadForm } from '@/components/custom/music/public-upload-form';
import { PublicUploadsChart } from '@/components/custom/music/public-uploads-chart';
import styles from './public-library-view.module.css';

export function PublicLibraryView() {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.pageTitle}>Libreria pubblica</h1>
        <p className={styles.lead}>
          Brani caricati dagli utenti di Solco, ascoltabili da tutti. Carica i tuoi: solo musica tua
          o libera (pubblico dominio / Creative Commons).
        </p>
      </header>

      <PublicUploadForm onUploaded={() => setReloadKey((key) => key + 1)} />

      <section className={styles.section} aria-labelledby="public-chart-heading">
        <h2 id="public-chart-heading" className={styles.sectionTitle}>
          Brani della community
        </h2>
        <PublicUploadsChart reloadKey={reloadKey} />
      </section>
    </main>
  );
}
