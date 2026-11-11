// @polsia:user-owned — Flashcard musicali: generi, i tuoi ascolti, teoria e storia. Il ripasso
// (metodo Leitner) è salvato solo in questo browser.
'use client';

import { Check, Layers, RotateCcw, Shuffle, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLibrary } from '@/components/custom/music/library-context';
import { Button } from '@/components/ui/button';
import {
  cardsToStudy,
  type DeckProgress,
  type Flashcard,
  genreDeck,
  gradeCard,
  historyDeck,
  masteredCount,
} from '@/lib/business/flashcards';
import { theoryCards } from '@/lib/music/flashcard-theory';
import styles from './flashcards.module.css';

const DECKS = [
  { id: 'generi', label: 'Generi' },
  { id: 'ascolti', label: 'I tuoi ascolti' },
  { id: 'teoria', label: 'Teoria e storia' },
] as const;
type DeckId = (typeof DECKS)[number]['id'];

const STORAGE_PREFIX = 'solco.flashcards.v1.';

function loadProgress(deck: DeckId): DeckProgress {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + deck);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return value && typeof value === 'object' ? (value as DeckProgress) : {};
  } catch {
    return {};
  }
}

function saveProgress(deck: DeckId, progress: DeckProgress) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + deck, JSON.stringify(progress));
  } catch {
    // Private mode or storage full: the session still works, progress is just not kept.
  }
}

function shuffled<T>(items: T[]) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

export function FlashcardsView() {
  const library = useLibrary();
  const [deck, setDeck] = useState<DeckId>('generi');
  const [progress, setProgress] = useState<DeckProgress>({});
  const [queue, setQueue] = useState<Flashcard[]>([]);
  const [flipped, setFlipped] = useState(false);
  const [session, setSession] = useState({ known: 0, review: 0 });

  const cards = useMemo(() => {
    if (deck === 'generi') return genreDeck();
    if (deck === 'ascolti') return historyDeck(library.library.history);
    return theoryCards;
  }, [deck, library.library.history]);

  const start = useCallback(
    (mix: boolean) => {
      const saved = loadProgress(deck);
      const study = cardsToStudy(cards, saved, Date.now());
      setProgress(saved);
      setQueue(mix ? shuffled(study) : study);
      setFlipped(false);
      setSession({ known: 0, review: 0 });
    },
    [cards, deck],
  );

  useEffect(() => {
    start(false);
  }, [start]);

  const current = queue[0];

  const grade = (knew: boolean) => {
    if (!current) return;
    const next = gradeCard(progress, current.id, knew, Date.now());
    setProgress(next);
    saveProgress(deck, next);
    setSession((value) => ({
      known: value.known + (knew ? 1 : 0),
      review: value.review + (knew ? 0 : 1),
    }));
    // A card to review comes back later in this session; a known one leaves the pile.
    setQueue((items) => {
      const rest = items.slice(1);
      if (knew) return rest;
      const at = Math.min(rest.length, 3);
      return [...rest.slice(0, at), current, ...rest.slice(at)];
    });
    setFlipped(false);
  };

  const reset = () => {
    saveProgress(deck, {});
    start(false);
  };

  const mastered = masteredCount(cards, progress);

  return (
    <div className={styles.wrap}>
      <div className={styles.tabs} role="tablist" aria-label="Mazzi">
        {DECKS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={deck === item.id}
            className={styles.tab}
            onClick={() => setDeck(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <p className={styles.stats}>
        <Layers aria-hidden="true" /> {cards.length} carte · {mastered} imparate · in questa
        sessione: {session.known} sapute, {session.review} da ripassare
      </p>

      {deck === 'ascolti' && !library.signedIn ? (
        <p className={styles.empty}>
          <Link href="/login?callbackURL=%2Fflashcards">Accedi</Link> per creare le carte dai brani
          che ascolti.
        </p>
      ) : deck === 'ascolti' && cards.length < 3 ? (
        <p className={styles.empty}>
          Ascolta qualche brano in più: le carte nascono dalla tua cronologia (titolo e artista).
        </p>
      ) : deck === 'teoria' && cards.length === 0 ? (
        <p className={styles.empty}>Le carte di teoria e storia arrivano presto.</p>
      ) : current ? (
        <>
          <button
            type="button"
            className={`${styles.card} ${flipped ? styles.flipped : ''}`}
            onClick={() => setFlipped((value) => !value)}
            aria-label={flipped ? 'Mostra la domanda' : 'Mostra la risposta'}
          >
            <span className={styles.topic}>{current.topic}</span>
            <span className={styles.face} aria-live="polite">
              {flipped ? current.back : current.front}
            </span>
            <span className={styles.hint}>
              {flipped ? 'Tocca per tornare alla domanda' : 'Tocca per girare la carta'}
            </span>
          </button>
          {flipped && current.link ? (
            <p className={styles.link}>
              <Link href={current.link.href}>{current.link.label} →</Link>
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button type="button" variant="outline" onClick={() => grade(false)}>
              <X aria-hidden="true" /> Da ripassare
            </Button>
            <Button type="button" onClick={() => grade(true)}>
              <Check aria-hidden="true" /> Lo sapevo
            </Button>
          </div>
          <p className={styles.remaining}>{queue.length} carte ancora in questa sessione</p>
        </>
      ) : (
        <p className={styles.empty}>
          Hai finito le carte di oggi per questo mazzo. Le carte che conosci tornano tra qualche
          giorno per un ripasso.
        </p>
      )}

      <div className={styles.footerActions}>
        <Button type="button" variant="ghost" size="sm" onClick={() => start(true)}>
          <Shuffle aria-hidden="true" /> Mescola
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={reset}>
          <RotateCcw aria-hidden="true" /> Ricomincia il mazzo
        </Button>
      </div>
    </div>
  );
}
