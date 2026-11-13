// @polsia:user-owned — ricerca musicale "mentre scrivi": un campo che, appena digiti, mostra i
// migliori brani (Audius, gratuito e senza quota) in un menù a tendina. Un clic avvia subito la
// riproduzione dal player globale; Invio (o "Vedi tutti") apre la pagina /search completa. Senza
// JavaScript il campo resta un form reale che naviga a /search (nessuna regressione).
'use client';

import { Loader2, Play, Search } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { type MusicPlayerTrack, useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { type AudiusTrackSearchResult, MusicSearchResponseSchema } from '@/lib/contracts/music';
import styles from './live-music-search.module.css';

const MAX_SUGGESTIONS = 6;
const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

function toPlayerTrack(track: AudiusTrackSearchResult): MusicPlayerTrack {
  return {
    qualifiedId: track.qualifiedId,
    title: track.title,
    artistName: track.artistName,
    artistUrl: track.artistUrl,
    artworkUrl: track.artworkUrl,
    sourceLabel: 'Solco · Audius',
    sourceUrl: track.trackUrl,
    sourceUrlLabel: 'Apri il brano su Audius',
    durationSeconds: track.durationSeconds,
    playbackMode: 'audius',
  };
}

export function LiveMusicSearch({
  placeholder = 'Brani, artisti, radio, podcast',
}: {
  placeholder?: string;
}) {
  const player = useMusicPlayer();
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AudiusTrackSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (term: string) => {
    const requestId = ++seq.current;
    setLoading(true);
    try {
      const response = await apiFetch(
        `/api/music/search?source=audius&q=${encodeURIComponent(term)}`,
        { schema: MusicSearchResponseSchema },
      );
      if (requestId !== seq.current) return;
      // Solo i brani riproducibili su Solco: sono i "migliori risultati" che l'utente può ascoltare.
      const playable = response.tracks
        .filter((track) => track.playbackEligible)
        .slice(0, MAX_SUGGESTIONS);
      setResults(playable);
      setActiveIndex(-1);
      setOpen(true);
    } catch {
      if (requestId !== seq.current) return;
      // In un typeahead un errore non va urlato a ogni tasto: semplicemente nessun suggerimento.
      setResults([]);
      setActiveIndex(-1);
    } finally {
      if (requestId === seq.current) setLoading(false);
    }
  }, []);

  const onChange = (value: string) => {
    setQuery(value);
    setActiveIndex(-1);
    if (debounce.current) clearTimeout(debounce.current);
    const term = value.trim();
    if (term.length < MIN_CHARS) {
      // Query troppo corta: annulla eventuali risposte in volo e chiudi.
      seq.current += 1;
      setResults([]);
      setLoading(false);
      setOpen(false);
      return;
    }
    debounce.current = setTimeout(() => void runSearch(term), DEBOUNCE_MS);
  };

  const goToFullSearch = useCallback(
    (term: string) => {
      const trimmed = term.trim();
      if (!trimmed) return;
      setOpen(false);
      router.push(`/search?q=${encodeURIComponent(trimmed)}`);
    },
    [router],
  );

  const playTrack = useCallback(
    (track: AudiusTrackSearchResult) => {
      setOpen(false);
      const selected = toPlayerTrack(track);
      if (player.currentTrack?.qualifiedId === selected.qualifiedId) {
        void player.togglePlayback();
        return;
      }
      const queue = results.map(toPlayerTrack);
      void player.playTrack(
        selected,
        `/api/music/audius/tracks/${encodeURIComponent(track.id)}/stream`,
        queue,
      );
    },
    [player, results],
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Invio su un suggerimento evidenziato → riproduce; altrimenti apre la ricerca completa.
    if (open && activeIndex >= 0 && results[activeIndex]) {
      event.preventDefault();
      playTrack(results[activeIndex]);
      return;
    }
    const term = query.trim();
    if (!term) return;
    event.preventDefault();
    goToFullSearch(term);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (!open || results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? results.length - 1 : index - 1));
    }
  };

  // Chiude il menù con un clic/tocco fuori dal componente.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  const showMenu = open && (loading || results.length > 0 || query.trim().length >= MIN_CHARS);

  return (
    <div className={styles.wrap} ref={containerRef}>
      {/* Form reale: senza JS, Invio naviga comunque a /search (progressive enhancement). */}
      <form action="/search" method="get" onSubmit={onSubmit}>
        <div className={styles.field}>
          {loading ? (
            <Loader2 aria-hidden="true" className={styles.spin} />
          ) : (
            <Search aria-hidden="true" />
          )}
          <input
            name="q"
            type="search"
            role="combobox"
            value={query}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => {
              if (results.length > 0 || query.trim().length >= MIN_CHARS) setOpen(true);
            }}
            maxLength={80}
            placeholder={placeholder}
            autoComplete="off"
            aria-label="Cerca un brano o un artista"
            aria-expanded={showMenu}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              activeIndex >= 0 && results[activeIndex]
                ? `${listId}-opt-${results[activeIndex]?.id}`
                : undefined
            }
          />
        </div>

        {showMenu ? (
          <div className={styles.menu} id={listId}>
            {results.map((track, index) => (
              <button
                key={track.id}
                id={`${listId}-opt-${track.id}`}
                type="button"
                className={
                  index === activeIndex
                    ? `${styles.optionButton} ${styles.active}`
                    : styles.optionButton
                }
                // onMouseDown invece di onClick: parte prima del blur dell'input, così il menù non
                // si chiude prima di registrare la scelta.
                onMouseDown={(event) => {
                  event.preventDefault();
                  playTrack(track);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className={styles.thumb}>
                  <Image src={track.artworkUrl} alt="" width={40} height={40} unoptimized />
                  <Play aria-hidden="true" className={styles.thumbPlay} />
                </span>
                <span className={styles.optionCopy}>
                  <strong className={styles.optionTitle}>{track.title}</strong>
                  <span className={styles.optionArtist}>{track.artistName}</span>
                </span>
              </button>
            ))}
            {query.trim().length >= MIN_CHARS ? (
              <button
                type="button"
                className={styles.seeAll}
                onMouseDown={(event) => {
                  event.preventDefault();
                  goToFullSearch(query);
                }}
              >
                {results.length === 0 && !loading
                  ? `Cerca “${query.trim()}” su Solco`
                  : `Vedi tutti i risultati per “${query.trim()}”`}
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
    </div>
  );
}
