// @polsia:user-owned — classifica «Brani più ascoltati dalla community»: i brani caricati dagli
// utenti, i più ascoltati prima (il server conta al massimo un ascolto al giorno per persona). Chi
// è loggato può segnalare un brano (moderazione) e rimuovere i propri.
'use client';

import { Flag, Lock, Pause, Play, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { publicUploadToTrack } from '@/components/custom/music/live-tracks';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { type PublicUpload, PublicUploadListResponseSchema } from '@/lib/contracts/public-uploads';
import { formatClock } from '@/lib/music/format-duration';
import styles from './public-uploads-chart.module.css';

/** Titolo della classifica della community (le parole lette dai lettori di schermo). */
export const COMMUNITY_CHART_TITLE = 'Brani più ascoltati dalla community';
/**
 * Le prime posizioni messe in risalto (solo colore e peso: nessuno spostamento del layout), ma solo
 * se hanno almeno un ascolto: in una classifica giovane un brano a "0 ascolti" non va sul podio.
 */
const PODIUM_SIZE = 3;

const playCountFormat = new Intl.NumberFormat('it-IT');

/**
 * Contenuto del titolo: il cuore è decorativo, nascosto ai lettori di schermo. Lo spazio prima è
 * indivisibile, così su schermi stretti il cuore non va a capo da solo.
 */
export function CommunityChartTitle() {
  return (
    <>
      {COMMUNITY_CHART_TITLE}
      {' '}
      <span className={styles.heart} aria-hidden="true">
        ❤️
      </span>
    </>
  );
}

function playCountLabel(count: number): string {
  return count === 1 ? '1 ascolto' : `${playCountFormat.format(count)} ascolti`;
}

export function PublicUploadsChart({
  reloadKey = 0,
  limit,
}: {
  reloadKey?: number;
  limit?: number;
}) {
  const player = useMusicPlayer();
  const [items, setItems] = useState<PublicUpload[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const { items: list } = await apiFetch('/api/music/public-uploads', {
        schema: PublicUploadListResponseSchema,
      });
      setItems(list);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Ricarica quando il genitore segnala un nuovo caricamento.
  useEffect(() => {
    if (reloadKey > 0) void load();
  }, [reloadKey, load]);

  const shown = typeof limit === 'number' ? items.slice(0, limit) : items;

  const play = (upload: PublicUpload) => {
    // I brani pubblicati sono ascoltabili solo dagli utenti Premium: senza streamUrl si mostra
    // l'invito a passare a Premium invece di provare a riprodurre.
    if (!upload.canPlay || !upload.streamUrl) {
      toast('Brano Premium', {
        description: 'I brani della community si ascoltano con Solco Premium.',
        action: {
          label: 'Scopri Premium',
          onClick: () => {
            window.location.href = '/piani';
          },
        },
      });
      return;
    }
    const track = publicUploadToTrack(upload);
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    // La coda contiene solo i brani ascoltabili (evita di fermarsi su un brano bloccato).
    const queue = shown.filter((item) => item.canPlay && item.streamUrl).map(publicUploadToTrack);
    void player.playTrack(track, upload.streamUrl, queue);
    // Conta l'ascolto (best-effort, non blocca la riproduzione).
    void fetch(`/api/music/public-uploads/${upload.id}/play`, { method: 'POST' }).catch(
      () => undefined,
    );
  };

  const report = async (upload: PublicUpload) => {
    if (
      !window.confirm(
        'Segnalare questo brano? Se più utenti lo segnalano, viene ritirato dalla libreria pubblica.',
      )
    ) {
      return;
    }
    try {
      await apiFetch(`/api/music/public-uploads/${upload.id}/report`, { method: 'POST' });
      toast.success('Segnalazione inviata. Grazie.');
    } catch {
      toast.error('Non è stato possibile inviare la segnalazione.');
    }
  };

  const remove = async (upload: PublicUpload) => {
    if (!window.confirm(`Rimuovere definitivamente “${upload.title}” dalla libreria pubblica?`)) {
      return;
    }
    try {
      await apiFetch(`/api/music/public-uploads/${upload.id}`, { method: 'DELETE' });
      setItems((current) => current.filter((item) => item.id !== upload.id));
      toast.success('Brano rimosso.');
    } catch {
      toast.error('Non è stato possibile rimuovere il brano.');
    }
  };

  if (state === 'loading') {
    return <p className={styles.state}>Carico la classifica…</p>;
  }
  if (state === 'error') {
    return <p className={styles.state}>Classifica non disponibile in questo momento.</p>;
  }
  if (items.length === 0) {
    return (
      <p className={styles.state}>
        La classifica della community è ancora vuota. Pubblica il primo brano e falla partire.
      </p>
    );
  }

  return (
    <ol className={styles.list}>
      {shown.map((upload, index) => {
        const qualifiedId = `upload:${upload.id}`;
        const playing =
          player.currentTrack?.qualifiedId === qualifiedId && player.status === 'playing';
        return (
          <li
            key={upload.id}
            className={styles.row}
            data-podium={index < PODIUM_SIZE && upload.playCount > 0 ? 'true' : undefined}
          >
            {/* La posizione la annuncia già l'elenco numerato (<ol>): il numero è solo visivo. */}
            <span className={styles.rank} aria-hidden="true">
              {index + 1}
            </span>
            <button
              type="button"
              className={styles.playButton}
              data-locked={upload.canPlay ? undefined : 'true'}
              onClick={() => play(upload)}
              aria-label={
                upload.canPlay
                  ? playing
                    ? `Metti in pausa ${upload.title}`
                    : `Riproduci ${upload.title}`
                  : `${upload.title} è un brano Premium: passa a Premium per ascoltarlo`
              }
            >
              {!upload.canPlay ? (
                <Lock aria-hidden="true" />
              ) : playing ? (
                <Pause aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
            </button>
            <div className={styles.copy}>
              <strong className={styles.title} title={upload.title}>
                {upload.title}
              </strong>
              <span className={styles.meta}>
                {upload.artist ? `${upload.artist} · ` : ''}
                {formatClock(upload.durationSeconds)} · {playCountLabel(upload.playCount)}
                {upload.canPlay ? null : <span className={styles.premiumTag}>Premium</span>}
              </span>
            </div>
            <div className={styles.actions}>
              {upload.mine ? (
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => void remove(upload)}
                  aria-label={`Rimuovi ${upload.title}`}
                  title="Rimuovi (è un tuo brano)"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => void report(upload)}
                  aria-label={`Segnala ${upload.title}`}
                  title="Segnala"
                >
                  <Flag aria-hidden="true" />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
