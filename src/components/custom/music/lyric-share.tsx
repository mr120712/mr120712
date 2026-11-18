// @polsia:user-owned — funzione Premium «Condividi una parte del testo». Si apre dal pannello del
// testo (lyrics-panel.tsx) e riceve il testo GIÀ caricato: non chiede nulla di nuovo e non tocca il
// controllo dei diritti (il testo esiste solo per i brani per cui Solco può mostrarlo). L'utente
// sceglie un breve estratto (due tocchi: prima riga e ultima riga, al massimo
// LYRIC_SHARE_MAX_LINES righe) e lo condivide come IMMAGINE con i crediti (il testo sta
// nell'immagine, mai come link indicizzabile). L'immagine si disegna nel browser (lyric-card-draw).
'use client';

import { Download, Share2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { Lyrics } from '@/lib/contracts/lyrics';
import {
  cardFileName,
  clampLineRange,
  fitExcerpt,
  LYRIC_SHARE_MAX_LINES,
  shareCaption,
} from '@/lib/music/lyric-card';
import { renderLyricCard } from '@/lib/music/lyric-card-draw';
import styles from './lyric-share.module.css';

export type LyricShareProps = {
  lyrics: Lyrics;
  title: string;
  artist: string;
  onClose: () => void;
};

type Picked = { start: number; end: number } | null;

export function LyricShare({ lyrics, title, artist, onClose }: LyricShareProps) {
  const lineTexts = useMemo(() => lyrics.lines.map((line) => line.text), [lyrics]);
  // Indici (sull'array originale) delle righe con testo: solo queste si possono toccare.
  const pickable = useMemo(
    () => lineTexts.map((text, index) => ({ text, index })).filter((row) => row.text.trim() !== ''),
    [lineTexts],
  );

  const [anchor, setAnchor] = useState<number | null>(null);
  const [picked, setPicked] = useState<Picked>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const fileRef = useRef<File | null>(null);
  const previewRef = useRef<string | null>(null);

  const excerpt = useMemo(() => {
    if (!picked) return null;
    return fitExcerpt(lineTexts.slice(picked.start, picked.end + 1));
  }, [picked, lineTexts]);

  const onLineTap = useCallback(
    (index: number) => {
      // Primo tocco (o dopo un intervallo completo): comincia un nuovo intervallo da questa riga.
      if (anchor === null || picked) {
        setAnchor(index);
        setPicked({ start: index, end: index });
        return;
      }
      // Secondo tocco: completa l'intervallo contiguo, al massimo LYRIC_SHARE_MAX_LINES righe.
      const range = clampLineRange(anchor, index);
      const reach = Math.abs(index - anchor) + 1;
      if (reach > LYRIC_SHARE_MAX_LINES) {
        toast(`Puoi condividere al massimo ${LYRIC_SHARE_MAX_LINES} righe.`);
      }
      setPicked(range);
      setAnchor(null);
    },
    [anchor, picked],
  );

  const reset = useCallback(() => {
    setAnchor(null);
    setPicked(null);
  }, []);

  // Disegna l'immagine quando cambia l'estratto; il file è pronto PRIMA del tocco su «Condividi»
  // (su iPhone navigator.share va chiamato subito, senza attese di rete in mezzo).
  useEffect(() => {
    fileRef.current = null;
    if (!excerpt || excerpt.lines.length === 0) {
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      return;
    }
    let active = true;
    setRendering(true);
    renderLyricCard({ lines: excerpt.lines, title, artist, credit: lyrics.credit })
      .then((blob) => {
        if (!active) return;
        if (!blob) {
          setRendering(false);
          toast.error('Non è stato possibile creare l’immagine.');
          return;
        }
        fileRef.current = new File([blob], cardFileName(title), { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        setPreview((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
        setRendering(false);
      })
      .catch(() => {
        if (active) setRendering(false);
      });
    return () => {
      active = false;
    };
  }, [excerpt, title, artist, lyrics.credit]);

  // Tiene l'ultimo URL per revocarlo allo smontaggio.
  previewRef.current = preview;
  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  // Chiusura con Esc.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shareImage = useCallback(async () => {
    const file = fileRef.current;
    if (!file) return;
    const data: ShareData = { title: `«${title}»`, text: shareCaption(title, artist) };
    const withFile: ShareData = { ...data, files: [file] };
    try {
      if (typeof navigator.share !== 'function') {
        toast('La condivisione diretta non è disponibile: usa «Scarica».');
        return;
      }
      const canShareFile =
        typeof navigator.canShare === 'function' ? navigator.canShare(withFile) : true;
      await navigator.share(canShareFile ? withFile : data);
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name !== 'AbortError') {
        toast.error('Condivisione non riuscita. Usa «Scarica» e carica l’immagine a mano.');
      }
    }
  }, [title, artist]);

  const download = useCallback(() => {
    if (!preview) return;
    const link = document.createElement('a');
    link.href = preview;
    link.download = cardFileName(title);
    document.body.append(link);
    link.click();
    link.remove();
  }, [preview, title]);

  const count = picked ? picked.end - picked.start + 1 : 0;
  const hint =
    anchor !== null && !picked
      ? 'Tocca l’ultima riga dell’estratto.'
      : picked
        ? `${count === 1 ? '1 riga scelta' : `${count} righe scelte`}. Tocca una riga per ricominciare.`
        : 'Tocca la prima riga del pezzo che vuoi condividere.';

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Condividi una parte del testo"
    >
      {/* Sfondo decorativo: chiude al tocco; la tastiera usa Esc e il pulsante «Chiudi». */}
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <div className={styles.sheet}>
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>Condividi una parte del testo</h2>
            <p className={styles.subtitle}>
              Scegli fino a {LYRIC_SHARE_MAX_LINES} righe: le condividi come immagine, con brano e
              crediti.
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="Chiudi" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </header>

        <div className={styles.body}>
          <ol className={styles.lines} aria-label="Righe del testo">
            {pickable.map((row) => {
              const selected =
                picked !== null && row.index >= picked.start && row.index <= picked.end;
              return (
                <li key={row.index}>
                  <button
                    type="button"
                    className={styles.line}
                    data-selected={selected ? 'true' : undefined}
                    aria-pressed={selected}
                    onClick={() => onLineTap(row.index)}
                  >
                    {row.text}
                  </button>
                </li>
              );
            })}
          </ol>

          <div className={styles.side}>
            <output className={styles.hint}>{hint}</output>
            {excerpt?.truncated ? (
              <p className={styles.trim}>
                L’estratto è stato accorciato per restare una parte del testo.
              </p>
            ) : null}
            <div className={styles.previewBox} data-empty={preview ? undefined : 'true'}>
              {preview ? (
                // biome-ignore lint/performance/noImgElement: immagine locale (blob), non da ottimizzare.
                <img className={styles.previewImg} src={preview} alt="Anteprima dell’immagine" />
              ) : (
                <span className={styles.previewPlaceholder}>
                  {rendering
                    ? 'Creazione dell’immagine…'
                    : 'Scegli le righe per vedere l’anteprima'}
                </span>
              )}
            </div>
            <div className={styles.actions}>
              <Button
                type="button"
                onClick={() => void shareImage()}
                disabled={!preview || rendering}
              >
                <Share2 aria-hidden="true" /> Condividi
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={download}
                disabled={!preview || rendering}
              >
                <Download aria-hidden="true" /> Scarica
              </Button>
              {picked ? (
                <Button type="button" variant="ghost" onClick={reset}>
                  Ricomincia
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
