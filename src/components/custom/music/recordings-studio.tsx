// @polsia:user-owned — pagina "Registra un brano": il registratore e l'elenco dei brani
// registrati dall'utente, riproducibili e cancellabili. Tutto ospitato su Solco.
'use client';

import { Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLibrary } from '@/components/custom/music/library-context';
import { recordingToTrack } from '@/components/custom/music/live-tracks';
import { trackStreamPath, useMusicPlayer } from '@/components/custom/music/music-player';
import { SongRecorder } from '@/components/custom/music/song-recorder';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { type Recording, RecordingListResponseSchema } from '@/lib/contracts/recordings';
import { formatClock } from '@/lib/music/recorder';
import styles from './recordings-studio.module.css';

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function RecordingsStudio() {
  const library = useLibrary();
  const player = useMusicPlayer();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!library.signedIn) {
      setState('ready');
      setRecordings([]);
      return;
    }
    let cancelled = false;
    setState('loading');
    apiFetch('/api/music/recordings', { schema: RecordingListResponseSchema })
      .then((value) => {
        if (!cancelled) {
          setRecordings(value.recordings);
          setState('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [library.signedIn]);

  const play = (recording: Recording) => {
    const track = recordingToTrack(recording);
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const path = trackStreamPath(track);
    if (!path) return;
    const queue = recordings.map(recordingToTrack);
    void player.playTrack(track, path, queue);
  };

  const remove = async (recording: Recording) => {
    try {
      await apiFetch(`/api/music/recordings/${recording.id}`, { method: 'DELETE' });
      setRecordings((current) => current.filter((item) => item.id !== recording.id));
      toast.success('Registrazione eliminata.');
    } catch {
      toast.error('Non è stato possibile eliminare la registrazione.');
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.pageTitle}>Registra un brano</h1>
        <p className={styles.lead}>
          Registra la tua musica dal microfono: resta ospitata interamente su Solco e la riascolti
          dalla tua Libreria. Niente servizi esterni, nessun problema di diritti.
        </p>
      </header>

      {library.signedIn ? (
        <SongRecorder
          onSaved={(recording) => setRecordings((current) => [recording, ...current])}
        />
      ) : (
        <div className={styles.signin}>
          <p>Accedi per registrare un brano e conservarlo nel tuo account.</p>
          <Button asChild>
            <a href="/login">Accedi</a>
          </Button>
        </div>
      )}

      <section className={styles.section} aria-labelledby="recordings-heading">
        <h2 id="recordings-heading" className={styles.sectionTitle}>
          Le tue registrazioni
        </h2>
        {state === 'loading' ? (
          <p className={styles.state}>Caricamento…</p>
        ) : state === 'error' ? (
          <p className={styles.state}>Elenco non disponibile in questo momento.</p>
        ) : recordings.length === 0 ? (
          <p className={styles.state}>
            {library.signedIn
              ? 'Non hai ancora registrato brani.'
              : 'Accedi per vedere le tue registrazioni.'}
          </p>
        ) : (
          <ul className={styles.list}>
            {recordings.map((recording) => {
              const qualifiedId = `recording:${recording.id}`;
              const playing =
                player.currentTrack?.qualifiedId === qualifiedId && player.status === 'playing';
              return (
                <li key={recording.id} className={styles.row}>
                  <button
                    type="button"
                    className={styles.playButton}
                    onClick={() => play(recording)}
                    aria-label={
                      playing ? `Metti in pausa ${recording.title}` : `Riproduci ${recording.title}`
                    }
                  >
                    {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                  </button>
                  <div className={styles.rowCopy}>
                    <strong title={recording.title}>{recording.title}</strong>
                    <span>
                      {formatClock(recording.durationSeconds)} · {formatDate(recording.createdAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.deleteButton}
                    onClick={() => void remove(recording)}
                    aria-label={`Elimina ${recording.title}`}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
