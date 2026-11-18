// @polsia:user-owned — pannello "Testo" del player a schermo intero (stile Spotify). Il testo si
// chiede solo all'apertura e a ogni cambio di brano (la richiesta precedente viene annullata):
// brani in evidenza e upload da GET /api/music/lyrics, file del dispositivo letti nel browser.
//
// Testo sincronizzato: la riga corrente segue il tempo dell'audio letto qui (getTime, ogni
// ~250 ms) e il pannello si aggiorna SOLO quando cambia riga, così il player non si ridisegna a
// ogni timeupdate. Con i tempi delle parole (Enhanced LRC, `words`) la lettura è ogni ~100 ms e la
// riga corrente evidenzia la parola che si sta cantando (karaoke), parola per parola. La riga
// resta al centro (scorrimento istantaneo con "riduci movimento"); se
// l'ascoltatore scorre a mano, lo scorrimento automatico si ferma per ~3 secondi. Ogni riga è un
// pulsante che porta l'audio a quel punto. Per i lettori di schermo la riga corrente ha
// aria-current (nessuna regione live che annuncia ogni riga). Testo semplice: righe leggibili.
'use client';

import { Loader2, RotateCcw, Share2 } from 'lucide-react';
import { type KeyboardEvent, memo, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { LYRICS_API_PATH, type Lyrics, LyricsResponseSchema } from '@/lib/contracts/lyrics';
import { activeLyricsLine, activeLyricsWord, LYRICS_INSTRUMENTAL } from '@/lib/music/lyrics';
import { LyricShare } from './lyric-share';
import styles from './lyrics-panel.module.css';
import type { LyricsTarget } from './lyrics-target';

/** Ogni quanto si rilegge il tempo dell'audio (solo con testo sincronizzato e pannello aperto). */
export const LYRICS_POLL_MS = 250;
/** Con i tempi delle parole la lettura è più fitta: la parola cambia più spesso della riga. */
export const LYRICS_WORD_POLL_MS = 100;
/** Dopo uno scorrimento manuale, lo scorrimento automatico riprende dopo questo tempo. */
export const LYRICS_MANUAL_SCROLL_PAUSE_MS = 3000;
/** Messaggio quando il brano non ha un testo (o non si ha il diritto di mostrarlo). */
export const LYRICS_UNAVAILABLE_MESSAGE = 'Testo non disponibile per questo brano';

type PanelState =
  | { status: 'loading' }
  | { status: 'ready'; lyrics: Lyrics }
  | { status: 'empty' }
  | { status: 'error' };

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

async function fetchLyrics(target: LyricsTarget, signal: AbortSignal): Promise<Lyrics | null> {
  if (target.source === 'local') {
    // Il lettore dei tag entra solo qui (import dinamico): niente rete, il file resta sul dispositivo.
    const { loadLocalLyrics } = await import('@/lib/local-music/lyrics');
    return loadLocalLyrics(target.id);
  }
  const query = `${target.source}=${encodeURIComponent(target.id)}`;
  const { lyrics } = await apiFetch(`${LYRICS_API_PATH}?${query}`, {
    schema: LyricsResponseSchema,
    signal,
    cache: 'no-store',
  });
  return lyrics;
}

/** "Riduci movimento" del sistema: lo scorrimento diventa istantaneo. */
function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export type LyricsPanelProps = {
  source: LyricsTarget['source'];
  /** Pathname del brano in evidenza, id dell'upload o id del file locale. */
  id: string;
  /** Secondi attuali dell'audio (letti dal player, senza farlo ridisegnare). */
  getTime: () => number;
  /** Porta l'audio a `seconds`. */
  onSeek: (seconds: number) => void;
  /**
   * Letto una volta all'apertura: true solo se l'ascoltatore ha appena premuto "Testo" (non a un
   * cambio di brano). Il pannello sta sotto i controlli: allora si porta in vista.
   */
  consumeReveal?: () => boolean;
  /** Account Premium: abilita «Condividi una parte del testo». */
  premium?: boolean;
  /** Brano e artista, per la scheda da condividere (funzione Premium). */
  trackTitle?: string;
  trackArtist?: string;
};

function LyricsPanelView({
  source,
  id,
  getTime,
  onSeek,
  consumeReveal,
  premium,
  trackTitle,
  trackArtist,
}: LyricsPanelProps) {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Compositore «Condividi una parte del testo» aperto (solo Premium).
  const [composing, setComposing] = useState(false);
  const [active, setActive] = useState(-1);
  // Parola corrente della riga corrente (-1 = nessuna, o riga senza tempi delle parole).
  const [activeWord, setActiveWord] = useState(-1);
  // Riga che riceve Tab (tabindex "itinerante"): null = segue la riga corrente.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const pausedUntilRef = useRef(0);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Aperto con "Testo": sul telefono il pannello è sotto il bordo dello schermo, si porta in vista
  // (istantaneo con "riduci movimento"). Solo al montaggio: mai a un cambio di brano.
  // biome-ignore lint/correctness/useExhaustiveDependencies: una sola volta, all'apertura.
  useEffect(() => {
    if (!consumeReveal?.()) return;
    const panel = panelRef.current;
    if (panel && typeof panel.scrollIntoView === 'function') {
      panel.scrollIntoView({
        block: 'start',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }, []);

  // Testo del brano: all'apertura e a ogni cambio di brano; la richiesta precedente si annulla.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` (Riprova) rifà la richiesta.
  useEffect(() => {
    const controller = new AbortController();
    // Il fuoco era su una riga (o su "Riprova") che sta per sparire: passa all'area del testo,
    // così tastiera e lettore di schermo non ripartono dall'inizio della pagina.
    const scroller = scrollRef.current;
    const focused = typeof document !== 'undefined' ? document.activeElement : null;
    if (scroller && focused && focused !== scroller && scroller.contains(focused)) {
      scroller.focus({ preventScroll: true });
    }
    setState({ status: 'loading' });
    setActive(-1);
    setActiveWord(-1);
    setFocusIndex(null);
    setComposing(false);
    pausedUntilRef.current = 0;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    fetchLyrics({ source, id } as LyricsTarget, controller.signal).then(
      (lyrics) => {
        if (controller.signal.aborted) return;
        setState(lyrics ? { status: 'ready', lyrics } : { status: 'empty' });
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [source, id, attempt]);

  const synced = state.status === 'ready' && state.lyrics.kind === 'synced' ? state.lyrics : null;
  const wordTimed = synced?.lines.some((line) => line.words) ?? false;

  // La riga corrente segue il tempo dell'audio: si ridisegna solo quando cambia riga (o parola).
  useEffect(() => {
    if (!synced) return;
    const tick = () => {
      const seconds = getTime();
      // Arrotondato: 2010 ms → 2,01 s → 2009,999… ms riporterebbe la riga precedente dopo un tocco.
      const ms = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
      const line = activeLyricsLine(synced.lines, ms);
      setActive(line);
      const words = synced.lines[line]?.words;
      setActiveWord(words ? activeLyricsWord(words, ms) : -1);
    };
    tick();
    const timer = setInterval(tick, wordTimed ? LYRICS_WORD_POLL_MS : LYRICS_POLL_MS);
    return () => clearInterval(timer);
  }, [synced, wordTimed, getTime]);

  const centreLine = useCallback((index: number) => {
    const container = scrollRef.current;
    const line = container?.querySelector<HTMLElement>(`[data-line="${index}"]`);
    if (!container || !line) return;
    const top = Math.max(0, line.offsetTop - container.clientHeight / 2 + line.offsetHeight / 2);
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
    if (typeof container.scrollTo === 'function') container.scrollTo({ top, behavior });
    else container.scrollTop = top;
  }, []);

  // Riga corrente al centro, salvo nei ~3 secondi dopo uno scorrimento manuale.
  useEffect(() => {
    if (active < 0 || Date.now() < pausedUntilRef.current) return;
    centreLine(active);
  }, [active, centreLine]);

  useEffect(
    () => () => {
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    },
    [],
  );

  /** L'ascoltatore scorre da sé: niente scorrimento automatico per un po', poi si ricentra. */
  const pauseAutoScroll = useCallback(() => {
    pausedUntilRef.current = Date.now() + LYRICS_MANUAL_SCROLL_PAUSE_MS;
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => {
      pausedUntilRef.current = 0;
      resumeTimerRef.current = null;
      if (activeRef.current >= 0) centreLine(activeRef.current);
    }, LYRICS_MANUAL_SCROLL_PAUSE_MS);
  }, [centreLine]);

  const seekLine = (index: number, timeMs: number | null) => {
    if (timeMs === null) return;
    // Toccare una riga è un comando, non uno scorrimento: si torna a seguire subito.
    pausedUntilRef.current = 0;
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    setFocusIndex(index);
    setActive(index);
    setActiveWord(-1);
    onSeek(timeMs / 1000);
  };

  /** La riga: parola per parola (karaoke) se ha i tempi delle parole, altrimenti il testo. */
  const renderLine = (line: Lyrics['lines'][number], current: boolean) => {
    if (!line.words) return line.text;
    return line.words.map((word, index) => (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: parole statiche, l'ordine non cambia.
        key={index}
        className={styles.word}
        data-state={
          current
            ? index < activeWord
              ? 'sung'
              : index === activeWord
                ? 'now'
                : 'next'
            : undefined
        }
      >
        {index > 0 ? ' ' : ''}
        {word.text}
      </span>
    ));
  };

  const lineCount = synced?.lines.length ?? 0;
  const rovingIndex = Math.min(Math.max(focusIndex ?? active, 0), Math.max(lineCount - 1, 0));

  const onLinesKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    if (lineCount === 0) return;
    const delta: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
    let next: number | null = null;
    if (event.key in delta) next = rovingIndex + (delta[event.key] ?? 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = lineCount - 1;
    if (next === null) return;
    event.preventDefault();
    const index = Math.min(Math.max(next, 0), lineCount - 1);
    setFocusIndex(index);
    pauseAutoScroll();
    scrollRef.current?.querySelector<HTMLElement>(`[data-line="${index}"]`)?.focus();
  };

  const credit = state.status === 'ready' ? state.lyrics.credit : null;

  return (
    <div ref={panelRef} className={styles.panel} data-lyrics-panel>
      <div className={styles.head}>
        <h2 className={styles.title}>Testo</h2>
        {premium && state.status === 'ready' ? (
          <button type="button" className={styles.share} onClick={() => setComposing(true)}>
            <Share2 aria-hidden="true" /> Condividi testo
          </button>
        ) : null}
      </div>
      {/* Area che scorre: raggiungibile da tastiera anche col testo semplice (frecce, pagina giù),
          come chiede WCAG per le regioni scorrevoli. I gestori riconoscono solo lo scorrimento
          manuale (rotella, dito, barra, tasti), non sono azioni. */}
      <section
        ref={scrollRef}
        className={styles.scroller}
        data-lyrics-scroller
        aria-label="Testo del brano"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: regione scorrevole, va messa a fuoco.
        tabIndex={0}
        onWheel={pauseAutoScroll}
        onTouchMove={pauseAutoScroll}
        onPointerDown={(event) => {
          // Sulla barra di scorrimento (il contenitore stesso), non su una riga.
          if (event.target === event.currentTarget) pauseAutoScroll();
        }}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget && SCROLL_KEYS.has(event.key)) pauseAutoScroll();
        }}
        aria-busy={state.status === 'loading'}
      >
        {state.status === 'loading' ? (
          <output className={styles.status}>
            <Loader2 aria-hidden="true" className={styles.spin} /> Caricamento del testo…
          </output>
        ) : null}
        {state.status === 'empty' ? (
          <output className={styles.status}>{LYRICS_UNAVAILABLE_MESSAGE}</output>
        ) : null}
        {state.status === 'error' ? (
          <div className={styles.status}>
            <output>Non è stato possibile caricare il testo.</output>
            <button
              type="button"
              className={styles.retry}
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RotateCcw aria-hidden="true" /> Riprova
            </button>
          </div>
        ) : null}
        {synced ? (
          <ol className={styles.lines} onKeyDown={onLinesKeyDown}>
            {synced.lines.map((line, index) => {
              const current = index === active;
              const instrumental = line.text === LYRICS_INSTRUMENTAL;
              return (
                <li key={`${index}-${line.timeMs}`}>
                  <button
                    type="button"
                    className={styles.line}
                    data-line={index}
                    data-state={current ? 'current' : index < active ? 'past' : 'future'}
                    aria-current={current ? 'true' : undefined}
                    tabIndex={index === rovingIndex ? 0 : -1}
                    aria-label={
                      instrumental
                        ? `Pausa strumentale, vai a ${formatTime(line.timeMs ?? 0)}`
                        : undefined
                    }
                    onClick={() => seekLine(index, line.timeMs)}
                    onFocus={() => setFocusIndex(index)}
                  >
                    {renderLine(line, current)}
                  </button>
                </li>
              );
            })}
          </ol>
        ) : null}
        {state.status === 'ready' && state.lyrics.kind === 'plain' ? (
          <div className={styles.plain}>
            {state.lyrics.lines.map((line, index) =>
              line.text === '' ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: righe statiche, l'ordine non cambia.
                <span key={index} className={styles.stanzaBreak} aria-hidden="true" />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: righe statiche, l'ordine non cambia.
                <p key={index}>{line.text}</p>
              ),
            )}
          </div>
        ) : null}
        {credit ? <p className={styles.credit}>{credit}</p> : null}
      </section>
      {composing && state.status === 'ready' ? (
        <LyricShare
          lyrics={state.lyrics}
          title={trackTitle ?? ''}
          artist={trackArtist ?? ''}
          onClose={() => setComposing(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * Pannello del testo. Memorizzato: il player si ridisegna a ogni avanzamento dell'audio, il
 * pannello no (props stabili; il tempo lo legge da sé con getTime).
 */
export const LyricsPanel = memo(LyricsPanelView);
