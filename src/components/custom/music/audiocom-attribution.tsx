// @polsia:user-owned — attribuzione e ascolto dei brani di audio.com nella ricerca.
//
// AudioComAttribution: distintivo della licenza (per le CC è il link al testo della licenza in
// italiano) e link «su audio.com» alla pagina del brano. Con titolo e autore già nella riga copre
// l'attribuzione chiesta dalle licenze CC (titolo, autore, fonte, licenza).
//
// AudioComEmbedDialog: per i brani che Solco NON riproduce (tutti i diritti riservati, nessuna
// licenza, licenze NC, licenza sconosciuta, cover) apre una piccola finestra con il player UFFICIALE
// di audio.com: solo l'iframe https://audio.com/embed/v2/audio/{id}?theme=dark (frame-src
// https://audio.com in next.user-config.ts), MAI lo script embed.js (lo script-src rigoroso di Solco
// lo bloccherebbe). L'iframe esiste solo a finestra aperta, con caricamento pigro, titolo e sandbox
// minima (script e stessa origine per il player, popup per i link verso audio.com).
// All'apertura il focus va sul titolo della finestra, MAI dentro l'iframe: con il focus in un
// documento di un'altra origine i tasti (Esc compreso) arriverebbero ad audio.com e non a Solco, e
// chi usa lo screen reader si troverebbe dentro il player esterno. L'iframe resta raggiungibile con
// Tab. Su schermi bassi la finestra scorre (CSS), così titolo e «Chiudi» restano raggiungibili.
'use client';

import { Headphones } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { AudioComTrack } from '@/lib/contracts/audiocom';
import {
  AUDIOCOM_COVER_CATEGORY,
  audioComEmbedUrl,
  audioComLicenseDeedUrl,
  audioComLicenseName,
  audioComLicenseShortLabel,
  isAudioComPlayable,
  isAudioComPlayableLicense,
} from '@/lib/music/audiocom-license';
import styles from './audiocom-attribution.module.css';

/** Permessi dell'iframe del player ufficiale: il minimo perché suoni e apra i link ad audio.com. */
export const AUDIOCOM_EMBED_SANDBOX =
  'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';

export function AudioComAttribution({ track }: { track: AudioComTrack }) {
  const deedUrl = audioComLicenseDeedUrl(track.license);
  const name = audioComLicenseName(track.license);
  const short = audioComLicenseShortLabel(track.license);
  const playable = isAudioComPlayable(track);
  return (
    <small className={styles.notice}>
      {deedUrl ? (
        <a
          href={deedUrl}
          className={styles.license}
          data-playable={playable ? 'true' : 'false'}
          target="_blank"
          rel="noopener noreferrer"
          title={`Licenza ${name}`}
        >
          {short}
          <span className="sr-only">: licenza {name} (si apre in una nuova scheda)</span>
        </a>
      ) : (
        <span className={styles.license} data-playable="false" title={name}>
          {short}
        </span>
      )}
      <a href={track.pageUrl} target="_blank" rel="noopener noreferrer">
        su audio.com
        <span className="sr-only">
          : {track.title} di {track.authorName} (si apre in una nuova scheda)
        </span>
      </a>
    </small>
  );
}

export function AudioComEmbedDialog({
  track,
  onOpen,
}: {
  track: AudioComTrack;
  /** All'apertura (es. mettere in pausa il player di Solco, per non sentire due brani insieme). */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const embedUrl = audioComEmbedUrl(track.id);
  if (!embedUrl) return null;
  const name = audioComLicenseName(track.license);
  // Perché non suona in Solco: cover (la licenza copre la registrazione, non la canzone originale),
  // licenza non ammessa, oppure licenza ammessa ma senza un indirizzo audio valido.
  const reason =
    track.category === AUDIOCOM_COVER_CATEGORY
      ? 'È una cover: la licenza di chi l’ha caricata copre la sua registrazione, non la canzone originale, quindi non la riproduciamo nel player di Solco e la ascolti con il player di audio.com'
      : isAudioComPlayableLicense(track.license)
        ? 'L’audio di questo brano non è disponibile per il player di Solco, quindi lo ascolti con il player di audio.com'
        : 'Questo brano non ha una licenza che permetta di riprodurlo nel player di Solco, quindi lo ascolti con il player di audio.com';
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className={styles.embedTrigger}>
          <Headphones aria-hidden="true" />
          Ascolta su audio.com
          <span className="sr-only">: {track.title}</span>
        </button>
      </DialogTrigger>
      <DialogContent
        className={styles.dialog}
        onOpenAutoFocus={(event) => {
          // Focus sul titolo, non sul primo elemento raggiungibile (l'iframe di audio.com).
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle ref={titleRef} tabIndex={-1} className={styles.dialogTitle}>
            {track.title}
          </DialogTitle>
          <DialogDescription>{track.authorName} · player ufficiale di audio.com</DialogDescription>
        </DialogHeader>
        {open ? (
          <iframe
            src={embedUrl}
            title={`Player di audio.com: ${track.title} di ${track.authorName}`}
            className={styles.frame}
            loading="lazy"
            sandbox={AUDIOCOM_EMBED_SANDBOX}
            allow="autoplay; encrypted-media"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : null}
        <p className={styles.dialogNote}>
          Licenza: {name}. {reason} (che riceve i dati tecnici della connessione).{' '}
          <a href={track.pageUrl} target="_blank" rel="noopener noreferrer">
            Apri la pagina su audio.com
            <span className="sr-only"> (si apre in una nuova scheda)</span>
          </a>
        </p>
      </DialogContent>
    </Dialog>
  );
}
