// @polsia:user-owned — ricerca musicale "mentre scrivi": un campo che, appena digiti, mostra i
// migliori brani (Audius, gratuito e senza quota) in un menù a tendina. Un clic avvia subito la
// riproduzione dal player globale; Invio (o "Vedi tutti") apre la pagina /search completa. Senza
// JavaScript il campo resta un form reale che naviga a /search (nessuna regressione).
//
// Chi ha fatto l'accesso vede in cima anche «Dalla tua Libreria»: fino a 2 raccolte (playlist o
// Preferiti, aprono la Libreria con il link diretto /library?playlist=<id>) e fino a 3 brani salvati,
// che suonano ESATTAMENTE come nella Libreria (collectionItemToTrack / collectionQueue /
// playCollectionItem). I dati arrivano dall'endpoint PRIVATO /api/music/library/search, in parallelo
// alla richiesta Audius (pubblica e cacheabile, che non porta mai dati di un account): stesso debounce,
// stessa lunghezza minima, la richiesta precedente viene annullata e una risposta vecchia ignorata.
// Qualsiasi errore (anche 401/429) nasconde in silenzio solo quel gruppo. Le due risposte entrano a
// schermo insieme (la prima aspetta l'altra al massimo ANSWER_GRACE_MS) e la voce evidenziata si
// segue per id, non per posizione: una risposta in arrivo non la sposta né la cancella.
'use client';

import { Loader2, Play, Search } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  collectionItemToTrack,
  collectionQueue,
  playCollectionItem,
} from '@/components/custom/music/collection-tracks';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useLibrary } from '@/components/custom/music/library-context';
import { type MusicPlayerTrack, useMusicPlayer } from '@/components/custom/music/music-player';
import { PlaylistMosaic } from '@/components/custom/music/playlist-mosaic';
import { apiFetch } from '@/lib/api-client';
import {
  type LibrarySearchCollection,
  type LibrarySearchResponse,
  LibrarySearchResponseSchema,
  type LibrarySearchTrack,
} from '@/lib/contracts/library-search';
import { type AudiusTrackSearchResult, MusicSearchResponseSchema } from '@/lib/contracts/music';
import { libraryPlaylistPath } from '@/lib/music/library-links';
import styles from './live-music-search.module.css';

const MAX_SUGGESTIONS = 6;
/** Raccolte della Libreria mostrate nel menù (la pagina /search le mostra tutte). */
const MAX_LIBRARY_COLLECTIONS = 2;
/** Brani salvati mostrati nel menù: solo quelli che possono partire, come nella Libreria. */
const MAX_LIBRARY_TRACKS = 3;
const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;
/**
 * Le due risposte di una ricerca (Libreria e Audius) entrano a schermo insieme: la prima aspetta
 * l'altra al massimo per questo tempo. Così il menù cambia una volta sola per ricerca e il gruppo
 * della Libreria non si inserisce sopra suggerimenti Audius già visibili (le voci sotto un puntatore
 * fermo non scivolano via). Oltre questa attesa la risposta lenta arriva da sola, quando c'è.
 */
export const ANSWER_GRACE_MS = 300;
/** Trattino, lineetta e lineetta lunga: «Artista - Titolo» si confronta anche senza separatore. */
const SEPARATOR_CHARS = /[-–—]/;

/** Una voce del menù, nell'ordine in cui compare: prima la Libreria, poi Audius. */
type SuggestionOption =
  | { kind: 'collection'; domId: string; collection: LibrarySearchCollection }
  | { kind: 'library-track'; domId: string; track: LibrarySearchTrack }
  | { kind: 'audius'; domId: string; track: AudiusTrackSearchResult };

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

/** Le voci della Libreria che il menù mostra: poche raccolte e solo brani che possono partire. */
function libraryPicks(result: LibrarySearchResponse | null) {
  if (!result) return { collections: [], tracks: [] };
  return {
    collections: result.collections.slice(0, MAX_LIBRARY_COLLECTIONS),
    tracks: result.tracks
      .filter((track) => collectionItemToTrack(track) !== null)
      .slice(0, MAX_LIBRARY_TRACKS),
  };
}

/**
 * Vero se la Libreria non ha di sicuro risultati per `term`, perché non ne ha avuti per `emptyTerm`,
 * di cui `term` è un'estensione. Il confronto del server è per sottostringa (normalizeText +
 * includes in library-search.server.ts): ciò che contiene «notturno» contiene anche «nott». Unica
 * eccezione, la forma «Artista - Titolo» (il separatore si toglie dalla query): un termine vuoto con
 * un trattino non vale come prefisso. Così una ricerca lunga non raddoppia le richieste sul limite
 * condiviso con Audius (`music.search`) quando la Libreria non ha già più nulla da mostrare.
 */
export function libraryKnownEmpty(term: string, emptyTerm: string | null) {
  return emptyTerm !== null && !SEPARATOR_CHARS.test(emptyTerm) && term.startsWith(emptyTerm);
}

function trackCountLabel(count: number) {
  return count === 1 ? '1 brano' : `${count} brani`;
}

/** Testo per lettori di schermo: quante voci per gruppo, annunciato quando arrivano. */
function resultsStatus(libraryCount: number, audiusCount: number) {
  if (libraryCount === 0 && audiusCount === 0) {
    return 'Nessun suggerimento. Premi Invio per la ricerca completa.';
  }
  const parts: string[] = [];
  if (libraryCount > 0) {
    parts.push(
      libraryCount === 1
        ? '1 risultato dalla tua Libreria'
        : `${libraryCount} risultati dalla tua Libreria`,
    );
  }
  if (audiusCount > 0) {
    parts.push(audiusCount === 1 ? '1 brano da Audius' : `${audiusCount} brani da Audius`);
  }
  return `${parts.join(' e ')}. Usa le frecce su e giù per sceglierne uno.`;
}

export function LiveMusicSearch({
  placeholder = 'Brani, artisti, radio, podcast',
}: {
  placeholder?: string;
}) {
  const player = useMusicPlayer();
  const router = useRouter();
  const { signedIn } = useLibrary();
  const listId = useId();
  const libraryLabelId = useId();
  const audiusLabelId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AudiusTrackSearchResult[]>([]);
  // «Dalla tua Libreria»: null = gruppo nascosto (senza accesso, errore o campo svuotato).
  const [library, setLibrary] = useState<LibrarySearchResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // La voce evidenziata, per id (domId): resta la stessa quando arriva l'altra risposta.
  const [activeId, setActiveId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const libraryRequest = useRef<AbortController | null>(null);
  // Attesa della seconda risposta di una ricerca (vedi ANSWER_GRACE_MS).
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ultimo termine per cui la Libreria non ha trovato nulla (vedi libraryKnownEmpty).
  const libraryEmptyTerm = useRef<string | null>(null);
  // Letto quando scatta il debounce: conta lo stato della sessione in quel momento.
  const signedInRef = useRef(signedIn);

  const cancelLibraryRequest = useCallback(() => {
    libraryRequest.current?.abort();
    libraryRequest.current = null;
  }, []);

  const cancelGrace = useCallback(() => {
    if (graceTimer.current) clearTimeout(graceTimer.current);
    graceTimer.current = null;
  }, []);

  // Cambio di sessione: quello che si sapeva della Libreria non vale più. All'uscita niente più
  // richieste private, il gruppo sparisce subito e con lui un'eventuale voce evidenziata (l'indice
  // non scivola su un suggerimento Audius mai scelto).
  useEffect(() => {
    signedInRef.current = signedIn;
    libraryEmptyTerm.current = null;
    if (!signedIn) {
      cancelLibraryRequest();
      setLibrary(null);
      setActiveId(null);
    }
  }, [signedIn, cancelLibraryRequest]);

  const runSearch = useCallback(
    async (term: string) => {
      const requestId = ++seq.current;
      cancelLibraryRequest();
      cancelGrace();
      setLoading(true);
      const isLatest = () => requestId === seq.current;
      const libraryEmpty = libraryKnownEmpty(term, libraryEmptyTerm.current);
      const withLibrary = signedInRef.current && !libraryEmpty;

      // Le risposte arrivate ma non ancora a schermo: entrano tutte insieme (vedi ANSWER_GRACE_MS).
      let pending = withLibrary ? 2 : 1;
      let released = false;
      let queued: Array<() => void> = [];
      // Libreria senza risultati già nota: il gruppo (di una ricerca precedente) sparisce con Audius.
      if (signedInRef.current && libraryEmpty) queued.push(() => setLibrary(null));
      const show = () => {
        const updates = queued;
        queued = [];
        for (const update of updates) update();
      };
      const answer = (update: () => void) => {
        pending -= 1;
        if (!isLatest()) return;
        queued.push(update);
        if (pending === 0) {
          // Lo spinner resta finché entrambe le richieste (se partite) non hanno risposto.
          cancelGrace();
          show();
          setLoading(false);
          return;
        }
        if (released) {
          show();
          return;
        }
        graceTimer.current ??= setTimeout(() => {
          graceTimer.current = null;
          if (!isLatest()) return;
          released = true;
          show();
        }, ANSWER_GRACE_MS);
      };

      if (withLibrary) {
        // Endpoint privato e separato (sessione obbligatoria, `private, no-store`): i dati di un
        // account non entrano mai in una risposta condivisa o in cache.
        const controller = new AbortController();
        libraryRequest.current = controller;
        void apiFetch(`/api/music/library/search?${new URLSearchParams({ q: term }).toString()}`, {
          schema: LibrarySearchResponseSchema,
          signal: controller.signal,
          cache: 'no-store',
        })
          .then((value): (() => void) => {
            if (
              isLatest() &&
              !controller.signal.aborted &&
              value.collections.length === 0 &&
              value.tracks.length === 0
            ) {
              libraryEmptyTerm.current = term;
            }
            return () => {
              // Uscita dall'account mentre la risposta aspettava l'altra: non si mostra più.
              if (controller.signal.aborted || !signedInRef.current) return;
              setLibrary(value);
              const picks = libraryPicks(value);
              if (picks.collections.length + picks.tracks.length > 0) setOpen(true);
            };
          })
          // 401, 429, rete giù, contratto cambiato: il gruppo sparisce, Audius resta com'è.
          .catch(() => () => setLibrary(null))
          .then((update) => {
            if (libraryRequest.current === controller) libraryRequest.current = null;
            answer(update);
          });
      }

      let audiusUpdate: () => void;
      try {
        const response = await apiFetch(
          `/api/music/search?source=audius&q=${encodeURIComponent(term)}`,
          { schema: MusicSearchResponseSchema },
        );
        // Solo i brani riproducibili su Solco: sono i "migliori risultati" che l'utente può ascoltare.
        const playable = response.tracks
          .filter((track) => track.playbackEligible)
          .slice(0, MAX_SUGGESTIONS);
        audiusUpdate = () => {
          setResults(playable);
          setOpen(true);
        };
      } catch {
        // In un typeahead un errore non va urlato a ogni tasto: semplicemente nessun suggerimento.
        audiusUpdate = () => setResults([]);
      }
      answer(audiusUpdate);
    },
    [cancelLibraryRequest, cancelGrace],
  );

  const onChange = (value: string) => {
    setQuery(value);
    setActiveId(null);
    if (debounce.current) clearTimeout(debounce.current);
    const term = value.trim();
    if (term.length < MIN_CHARS) {
      // Query troppo corta: annulla eventuali risposte in volo e chiudi (si ricomincia da capo).
      seq.current += 1;
      cancelLibraryRequest();
      cancelGrace();
      libraryEmptyTerm.current = null;
      setResults([]);
      setLibrary(null);
      setLoading(false);
      setOpen(false);
      return;
    }
    // I gruppi già a schermo restano finché non arriva la risposta nuova: niente sfarfallio.
    debounce.current = setTimeout(() => void runSearch(term), DEBOUNCE_MS);
  };

  const libraryShown = useMemo(() => libraryPicks(library), [library]);
  // La coda sono i brani salvati mostrati, nell'ordine mostrato (come le altre code della ricerca).
  const libraryQueue = useMemo(() => collectionQueue(libraryShown.tracks), [libraryShown.tracks]);
  const libraryCount = libraryShown.collections.length + libraryShown.tracks.length;

  // Tutte le voci nell'ordine visivo: la navigazione da tastiera le percorre così.
  const options = useMemo<SuggestionOption[]>(
    () => [
      ...libraryShown.collections.map(
        (collection): SuggestionOption => ({
          kind: 'collection',
          domId: `${listId}-col-${collection.id}`,
          collection,
        }),
      ),
      ...libraryShown.tracks.map(
        (track): SuggestionOption => ({
          kind: 'library-track',
          domId: `${listId}-lib-${track.id}`,
          track,
        }),
      ),
      ...results.map(
        (track): SuggestionOption => ({
          kind: 'audius',
          domId: `${listId}-opt-${track.id}`,
          track,
        }),
      ),
    ],
    [libraryShown, results, listId],
  );

  const activeIndex = activeId === null ? -1 : options.findIndex((o) => o.domId === activeId);
  // La voce evidenziata non è più fra quelle mostrate: si dimentica (non ricompare più tardi).
  useEffect(() => {
    if (activeId !== null && activeIndex === -1) setActiveId(null);
  }, [activeId, activeIndex]);

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

  const activate = useCallback(
    (option: SuggestionOption) => {
      if (option.kind === 'audius') {
        playTrack(option.track);
        return;
      }
      setOpen(false);
      if (option.kind === 'collection') {
        router.push(libraryPlaylistPath(option.collection.id));
        return;
      }
      // Stesso avvio della Libreria: sul brano in corso mette in pausa o riprende.
      playCollectionItem(player, option.track, libraryQueue);
    },
    [playTrack, router, player, libraryQueue],
  );

  const activeOption = open && activeIndex >= 0 ? options[activeIndex] : undefined;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Invio su un suggerimento evidenziato → lo apre/riproduce; altrimenti la ricerca completa.
    if (activeOption) {
      event.preventDefault();
      activate(activeOption);
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
      setActiveId(null);
      return;
    }
    if (event.key === 'Enter' && activeOption) {
      // Come l'invio del form: la voce evidenziata, senza aprire la ricerca completa.
      event.preventDefault();
      activate(activeOption);
      return;
    }
    if (!open || options.length === 0) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const next =
      event.key === 'ArrowDown'
        ? (activeIndex + 1) % options.length
        : activeIndex <= 0
          ? options.length - 1
          : activeIndex - 1;
    const target = options[next];
    if (!target) return;
    setActiveId(target.domId);
    // La voce scelta da tastiera resta visibile quando il menù scorre (solo da tastiera: col mouse
    // la voce sotto il puntatore è già visibile e uno scorrimento la farebbe "scappare").
    document.getElementById(target.domId)?.scrollIntoView?.({ block: 'nearest' });
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
      if (graceTimer.current) clearTimeout(graceTimer.current);
      libraryRequest.current?.abort();
    },
    [],
  );

  const showMenu = open && (loading || options.length > 0 || query.trim().length >= MIN_CHARS);
  const showLibraryGroup = libraryCount > 0;
  const status = showMenu && !loading ? resultsStatus(libraryCount, results.length) : '';

  const optionClass = (index: number) =>
    index === activeIndex ? `${styles.optionButton} ${styles.active}` : styles.optionButton;

  const renderOption = (option: SuggestionOption, index: number) => {
    // Attributi comuni a tutte le voci; type e role restano espliciti su ogni <button>.
    const common = {
      id: option.domId,
      'aria-selected': index === activeIndex,
      // Il focus resta nel campo (aria-activedescendant): le voci non entrano nel giro del Tab.
      tabIndex: -1,
      className: optionClass(index),
      // onMouseDown invece di onClick: parte prima del blur dell'input, così il menù non si chiude
      // prima di registrare la scelta.
      onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        activate(option);
      },
      onMouseEnter: () => setActiveId(option.domId),
    };

    if (option.kind === 'collection') {
      const { collection } = option;
      return (
        <button key={option.domId} type="button" role="option" {...common} data-kind="collection">
          <span className={styles.thumb}>
            <PlaylistMosaic
              name={collection.name}
              items={collection.covers.map((artworkUrl) => ({ artworkUrl }))}
            />
          </span>
          <span className={styles.optionCopy}>
            <strong className={styles.optionTitle} dir="auto">
              {collection.name}
            </strong>
            <span className={styles.optionArtist}>
              {collection.kind === 'favorites' ? 'Preferiti' : 'Playlist'} ·{' '}
              {trackCountLabel(collection.itemCount)}
            </span>
          </span>
        </button>
      );
    }

    if (option.kind === 'library-track') {
      const { track } = option;
      return (
        <button
          key={option.domId}
          type="button"
          role="option"
          {...common}
          data-kind="library-track"
        >
          <span className={styles.thumb}>
            <FallbackArt src={track.artworkUrl} label={track.title} size={40} />
            <Play aria-hidden="true" className={styles.thumbPlay} />
          </span>
          <span className={styles.optionCopy}>
            <strong className={styles.optionTitle} dir="auto">
              {track.title}
            </strong>
            <span className={styles.optionArtist} dir="auto">
              {track.creatorName ? `${track.creatorName} · ` : null}in {track.collectionName}
            </span>
          </span>
        </button>
      );
    }

    const { track } = option;
    return (
      <button key={option.domId} type="button" role="option" {...common} data-kind="audius">
        <span className={styles.thumb}>
          <Image src={track.artworkUrl} alt="" width={40} height={40} unoptimized />
          <Play aria-hidden="true" className={styles.thumbPlay} />
        </span>
        <span className={styles.optionCopy}>
          <strong className={styles.optionTitle}>{track.title}</strong>
          <span className={styles.optionArtist}>{track.artistName}</span>
        </span>
      </button>
    );
  };

  const libraryOptions = options.slice(0, libraryCount);
  const audiusOptions = options.slice(libraryCount);

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
              if (options.length > 0 || query.trim().length >= MIN_CHARS) setOpen(true);
            }}
            maxLength={80}
            placeholder={placeholder}
            autoComplete="off"
            aria-label="Cerca un brano o un artista"
            aria-expanded={showMenu}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOption?.domId}
          />
        </div>

        {/* Sempre nel DOM: i lettori di schermo annunciano i conteggi quando cambiano. */}
        <output className="sr-only" aria-live="polite">
          {status}
        </output>

        {showMenu ? (
          <div className={styles.menu}>
            {/* Solo l'elenco scorre: «Vedi tutti» resta sempre visibile in fondo al menù. */}
            <div
              role="listbox"
              id={listId}
              aria-label="Suggerimenti di ricerca"
              className={styles.list}
            >
              {showLibraryGroup ? (
                // biome-ignore lint/a11y/useSemanticElements: gruppo di opzioni in un listbox (pattern ARIA); <fieldset> è per i campi di un form.
                <div role="group" aria-labelledby={libraryLabelId} className={styles.group}>
                  <div role="presentation" id={libraryLabelId} className={styles.groupLabel}>
                    Dalla tua Libreria
                  </div>
                  {libraryOptions.map((option, index) => renderOption(option, index))}
                </div>
              ) : null}
              {audiusOptions.length > 0 && showLibraryGroup ? (
                // biome-ignore lint/a11y/useSemanticElements: gruppo di opzioni in un listbox (pattern ARIA); <fieldset> è per i campi di un form.
                <div role="group" aria-labelledby={audiusLabelId} className={styles.group}>
                  <div role="presentation" id={audiusLabelId} className={styles.groupLabel}>
                    Da Audius
                  </div>
                  {audiusOptions.map((option, index) => renderOption(option, libraryCount + index))}
                </div>
              ) : (
                audiusOptions.map((option, index) => renderOption(option, libraryCount + index))
              )}
            </div>
            {query.trim().length >= MIN_CHARS ? (
              <button
                type="button"
                className={styles.seeAll}
                onMouseDown={(event) => {
                  event.preventDefault();
                  goToFullSearch(query);
                }}
              >
                {options.length === 0 && !loading
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
