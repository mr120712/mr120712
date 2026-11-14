// @polsia:user-owned — "Rimuovi video": per chi non vuole vedere il video YouTube.
//
// YouTube non consente di nascondere il suo player lasciando l'audio (niente "solo audio", niente
// background). Quindi:
// 1. si cerca lo stesso brano in una versione SOLO AUDIO lecita (Audius o Jamendo, lo stesso flusso
//    di "Ascolta in background"): se c'è, prende il posto del video nella coda e il video sparisce;
// 2. se non c'è, il video viene rimosso e la sua musica si ferma: si passa al brano successivo
//    della coda, oppure il player si chiude.
// Se nel frattempo il brano è cambiato, il risultato arrivato in ritardo non tocca nulla.
'use client';

import { Loader2, VideoOff } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { type BackgroundVideo, useBackgroundListen } from './background-listen-button';

// Non "sta suonando": la versione solo audio prende il posto del video nella coda, ma il player
// può fermarla (es. ascolti Free finiti) e in quel caso lo spiega lui stesso.
export const REMOVE_VIDEO_AUDIO_TEXT = 'Video rimosso: al suo posto c’è la versione solo audio.';
export const REMOVE_VIDEO_ONLY_VIDEO_TEXT =
  'Questo brano esiste solo come video su YouTube: senza video la sua musica si ferma (YouTube non permette l’ascolto senza video né in background).';
export const REMOVE_VIDEO_SEARCH_ERROR_TEXT =
  'Non sono riuscito a cercare la versione solo audio, quindi la musica di questo video si ferma.';

/** Un secondo tocco subito dopo una rimozione colpirebbe il video successivo: si ignora. */
const REMOVAL_COOLDOWN_MS = 800;
let lastRemovalAt = 0;

export function RemoveVideoButton({
  video,
  onRemoveWithoutAudio,
  compact = false,
  className,
}: {
  video: BackgroundVideo;
  /**
   * Nessuna versione solo audio: il player toglie il video (brano successivo o chiusura); 'stale'
   * se nel frattempo il brano corrente non è più questo video (non si tocca nulla).
   */
  onRemoveWithoutAudio: (videoId: string) => 'next' | 'stopped' | 'stale';
  /** true: testo breve (barra del video); false: pulsante del player a schermo intero. */
  compact?: boolean;
  className?: string;
}) {
  const { availability, searching, start } = useBackgroundListen(video);
  // Una sola gestione per tocco: un doppio tocco su questo pulsante non ripete il messaggio.
  const handlingRef = useRef(false);

  const removeWithoutAudio = (reason: string) => {
    const result = onRemoveWithoutAudio(video.videoId);
    if (result === 'stale') return;
    lastRemovalAt = Date.now();
    toast('Video rimosso.', {
      description:
        result === 'next' ? `${reason} Passo al brano successivo.` : `${reason} Player chiuso.`,
    });
  };

  const remove = () => {
    if (handlingRef.current || Date.now() - lastRemovalAt < REMOVAL_COOLDOWN_MS) return;
    // Nessun catalogo solo audio configurato (controllo concluso): il video si toglie subito.
    if (availability === 'no') {
      removeWithoutAudio(REMOVE_VIDEO_ONLY_VIDEO_TEXT);
      return;
    }
    handlingRef.current = true;
    // start() è la prima istruzione del tocco: sblocca l'audio (iOS) prima dell'attesa di rete. Se
    // "Ascolta in background" sta già cercando lo stesso video, ci si aggancia a quella ricerca.
    start()
      .then(
        (outcome) => {
          if (outcome.status === 'stale') return;
          if (outcome.status === 'playing') {
            lastRemovalAt = Date.now();
            toast(REMOVE_VIDEO_AUDIO_TEXT, {
              description: `${outcome.track.title} · ${outcome.track.sourceLabel}`,
            });
            return;
          }
          removeWithoutAudio(
            outcome.status === 'error'
              ? REMOVE_VIDEO_SEARCH_ERROR_TEXT
              : REMOVE_VIDEO_ONLY_VIDEO_TEXT,
          );
        },
        () => removeWithoutAudio(REMOVE_VIDEO_SEARCH_ERROR_TEXT),
      )
      .finally(() => {
        handlingRef.current = false;
      });
  };

  const label = searching ? 'Cerco la versione audio…' : 'Rimuovi video';
  return (
    <button
      type="button"
      className={cn(className)}
      onClick={remove}
      aria-busy={searching || undefined}
      // Il nome accessibile comincia con il testo visibile (WCAG 2.5.3), poi il titolo.
      aria-label={`${label}: ${video.title}`}
      data-compact={compact || undefined}
    >
      {searching ? (
        <Loader2 aria-hidden="true" className="animate-spin" />
      ) : (
        <VideoOff aria-hidden="true" />
      )}
      <span>{label}</span>
    </button>
  );
}
