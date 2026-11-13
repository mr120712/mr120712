// @polsia:user-owned — pagina della libreria PUBBLICA: form di caricamento (per i loggati, fino a
// 3 brani) + gestione dei propri brani (rimozione per liberare un posto) + classifica pubblica.
'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLibrary } from '@/components/custom/music/library-context';
import { PublicUploadForm } from '@/components/custom/music/public-upload-form';
import { PublicUploadsChart } from '@/components/custom/music/public-uploads-chart';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  PUBLIC_UPLOAD_MAX_PER_USER,
  type PublicUpload,
  PublicUploadMineResponseSchema,
} from '@/lib/contracts/public-uploads';
import styles from './public-library-view.module.css';

export function PublicLibraryView() {
  const library = useLibrary();
  const [reloadKey, setReloadKey] = useState(0);
  // null = non ancora caricato o utente non loggato; array = i brani pubblici dell'utente.
  const [mine, setMine] = useState<PublicUpload[] | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadMine = useCallback(async () => {
    if (!library.signedIn) {
      setMine(null);
      return;
    }
    try {
      const data = await apiFetch('/api/music/public-uploads/mine', {
        schema: PublicUploadMineResponseSchema,
      });
      setMine(data.items);
    } catch {
      // Non blocca la pagina: il server fa comunque rispettare il tetto. Mostra "nessuno".
      setMine([]);
    }
  }, [library.signedIn]);

  useEffect(() => {
    void loadMine();
  }, [loadMine]);

  const count = mine?.length ?? 0;

  const handleUploaded = () => {
    setReloadKey((key) => key + 1);
    void loadMine();
  };

  const remove = async (id: string) => {
    setRemovingId(id);
    try {
      await apiFetch(`/api/music/public-uploads/${id}`, { method: 'DELETE' });
      toast.success('Brano rimosso dalla libreria pubblica.');
      setReloadKey((key) => key + 1);
      await loadMine();
    } catch {
      toast.error('Non è stato possibile rimuovere il brano.');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.pageTitle}>Libreria pubblica</h1>
        <p className={styles.lead}>
          Brani caricati dagli utenti di Solco, ascoltabili da tutti. Pubblica i tuoi: fino a{' '}
          {PUBLIC_UPLOAD_MAX_PER_USER} brani, solo musica tua o libera (pubblico dominio / Creative
          Commons).
        </p>
      </header>

      <PublicUploadForm
        onUploaded={handleUploaded}
        count={count}
        limit={PUBLIC_UPLOAD_MAX_PER_USER}
      />

      {library.signedIn && mine && mine.length > 0 ? (
        <section className={styles.section} aria-labelledby="my-uploads-heading">
          <h2 id="my-uploads-heading" className={styles.sectionTitle}>
            I tuoi brani pubblicati ({count}/{PUBLIC_UPLOAD_MAX_PER_USER})
          </h2>
          <ul className={styles.mineList}>
            {mine.map((upload) => (
              <li key={upload.id} className={styles.mineItem}>
                <div className={styles.mineInfo}>
                  <span className={styles.mineTitle}>{upload.title}</span>
                  <span
                    className={styles.mineStatus}
                    data-status={upload.published ? 'live' : 'review'}
                  >
                    <span className={styles.statusDot} aria-hidden="true" />
                    {upload.published ? 'Verificato · pubblicato' : 'In revisione'}
                    {upload.artist ? (
                      <span className={styles.mineArtist}> · {upload.artist}</span>
                    ) : null}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void remove(upload.id)}
                  disabled={removingId === upload.id}
                  aria-label={`Rimuovi ${upload.title}`}
                >
                  {removingId === upload.id ? (
                    <Loader2 aria-hidden="true" className={styles.spin} />
                  ) : (
                    <Trash2 aria-hidden="true" />
                  )}
                  Rimuovi
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="public-chart-heading">
        <h2 id="public-chart-heading" className={styles.sectionTitle}>
          Brani della community
        </h2>
        <PublicUploadsChart reloadKey={reloadKey} />
      </section>
    </main>
  );
}
