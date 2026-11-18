// @polsia:user-owned — funzione Premium «Condividi una parte del testo». Si apre dal pannello del
// testo (lyrics-panel.tsx) e riceve il testo GIÀ caricato: non chiede nulla di nuovo e non tocca il
// controllo dei diritti (il testo esiste solo per i brani per cui Solco può mostrarlo). L'utente
// sceglie un breve estratto (due tocchi: prima riga e ultima riga, al massimo
// LYRIC_SHARE_MAX_LINES righe) e lo condivide come IMMAGINE con i crediti (il testo sta
// nell'immagine, mai come link indicizzabile). L'immagine si disegna nel browser (lyric-card-draw).
'use client';

import { Download, Share2, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { Lyrics } from '@/lib/contracts/lyrics';
import {
  cardFileName,
  fitExcerpt,
  LYRIC_SHARE_MAX_LINES,
  type LyricSelection,
  shareCaption,
  tapSelection,
} from '@/lib/music/lyric-card';
import { renderLyricCard } from '@/lib/music/lyric-card-draw';
import styles from './lyric-share.module.css';

export type LyricShareProps = {
  lyrics: Lyrics;
  title: string;
  artist: string;
  onClose: () => void;
};

export function LyricShare({ lyrics, title, artist, onClose }: LyricShareProps) {
  // Solo le righe con testo si possono toccare; la scelta lavora sulla loro POSIZIONE fra queste,
  // così le righe vuote (pause strumentali) non falsano il conteggio dell'estratto.
  const pickable = useMemo(
    () =>
      lyrics.lines
        .map((line, index) => ({ text: line.text, index }))
        .filter((row) => row.text.trim() !== ''),
    [lyrics],
  );

  const [selection, setSelection] = useState<LyricSelection>({ anchor: null, range: null });
  const [preview, setPreview] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const fileRef = useRef<File | null>(null);
  const previewRef = useRef<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const excerpt = useMemo(() => {
    const range = selection.range;
    if (!range) return null;
    return fitExcerpt(pickable.slice(range.start, range.end + 1).map((row) => row.text));
  }, [selection, pickable]);

  const onLineTap = useCallback(
    (pos: number) => {
      // Secondo tocco troppo lontano: avvisa prima di tagliare a LYRIC_SHARE_MAX_LINES righe.
      if (
        selection.anchor !== null &&
        Math.abs(pos - selection.anchor) + 1 > LYRIC_SHARE_MAX_LINES
      ) {
        toast(`Puoi condividere al massimo ${LYRIC_SHARE_MAX_LINES} righe.`);
      }
      setSelection((prev) => tapSelection(prev, pos));
    },
    [selection.anchor],
  );

  const reset = useCallback(() => setSelection({ anchor: null, range: null }), []);

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

  // Finestra modale: porta il fuoco dentro il pannello all'apertura e lo riporta sul pulsante che
  // l'ha aperto alla chiusura (contratto aria-modal).
  useEffect(() => {
    const opener = (
      typeof document !== 'undefined' ? document.activeElement : null
    ) as HTMLElement | null;
    sheetRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Trappola del fuoco: con Tab il giro resta dentro il pannello.
  const onTrapKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const focusables = [
      ...sheet.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  }, []);

  const shareImage = useCallback(async () => {
    const file = fileRef.current;
    if (!file) return;
    const withFile: ShareData = {
      title: `«${title}»`,
      text: shareCaption(title, artist),
      files: [file],
    };
    // Senza condivisione di FILE, condividere la sola didascalia non ha senso (il testo sta
    // nell'immagine): meglio indicare «Scarica».
    const canShareFile =
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare(withFile);
    if (!canShareFile) {
      toast('Su questo dispositivo usa «Scarica» per salvare l’immagine.');
      return;
    }
    try {
      await navigator.share(withFile);
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

  const range = selection.range;
  const count = range ? range.end - range.start + 1 : 0;
  const hint =
    selection.anchor !== null
      ? 'Tocca l’ultima riga dell’estratto.'
      : range
        ? `${count === 1 ? '1 riga scelta' : `${count} righe scelte`}. Tocca una riga per ricominciare.`
        : 'Tocca la prima riga del pezzo che vuoi condividere.';

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Condividi una parte del testo"
      onKeyDown={onTrapKeyDown}
    >
      {/* Sfondo decorativo: chiude al tocco; la tastiera usa Esc e il pulsante «Chiudi». */}
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      {/* tabIndex -1: non entra nel giro dei Tab, ma riceve il fuoco all'apertura (finestra modale). */}
      <div className={styles.sheet} ref={sheetRef} tabIndex={-1}>
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
            {pickable.map((row, pos) => {
              const selected = range !== null && pos >= range.start && pos <= range.end;
              return (
                <li key={row.index}>
                  <button
                    type="button"
                    className={styles.line}
                    data-selected={selected ? 'true' : undefined}
                    aria-pressed={selected}
                    onClick={() => onLineTap(pos)}
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
              {range ? (
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
