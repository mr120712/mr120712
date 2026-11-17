// @polsia:user-owned — Cerca unificata: UN solo campo interroga i brani in evidenza di Solco (solo
// quelli con i diritti dichiarati), Audius, radio e podcast mentre si digita (gratis, nessuna
// chiamata a YouTube) e aggiunge YouTube solo all'invio esplicito (Invio o «Cerca»), senza mai
// bruciare la quota mentre si scrive. Mostra UN elenco misto, deduplicato e ordinato per rilevanza
// con un piccolo distintivo di fonte per riga; ogni riga suona nel player Solco (i brani «In
// evidenza» esattamente come in Home, con playHomeTrack, più il loro «Condividi» con link diretto
// quando il server manda shareId, cioè solo per i brani dichiarati, e «Scarica offline» SOLO quando
// il server manda anche `offline` true: la voce di diritti.json consente la copia offline; è lo
// stesso pulsante a icona delle pagine d'artista e di cartella, e senza accesso dice che serve
// accedere). Quando la quota YouTube è finita resta l'avviso con i risultati salvati e il link
// «Cerca su YouTube» (riusa youtube-search-notice).
// Chip-filtro opzionali (Tutto / Le tue / Brani / Radio / Podcast) restringono lo stesso elenco.
// Consuma UnifiedSearchResponseSchema via apiFetch. Per chi ha fatto l'accesso, in parallelo e da un
// endpoint PRIVATO (/api/music/library/search, mai dentro search-all che è in cache condivisa), la
// sezione «Le tue playlist» in cima: le sue raccolte e i brani salvati che corrispondono. Per gli
// admin (solo loro: AdminSearchHint non fa nulla per gli altri), sopra tutto, l'avviso sui brani in
// evidenza che corrispondono ma non compaiono (non dichiarati in diritti.json), da un altro
// endpoint privato in parallelo.
// audio.com (solo per una ricerca "completa": invio esplicito o link di ricerca, mai a ogni tasto,
// perché il limite di audio.com è condiviso da tutti) aggiunge brani con distintivo di licenza e
// attribuzione: suonano nel player solo con CC0 / CC BY / CC BY-SA / CC BY-ND (mai le cover),
// altrimenti «Ascolta su audio.com» apre il player ufficiale di audio.com in una finestra. Se
// audio.com non risponde lo dice una breve nota; se non è collegato il suggerimento non lo promette.
'use client';

import { ListMusic, Pause, Play, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { AdminSearchHint } from '@/components/custom/music/admin-search-hint';
import { AiMusicSearch } from '@/components/custom/music/ai-music-search';
import {
  AudioComAttribution,
  AudioComEmbedDialog,
} from '@/components/custom/music/audiocom-attribution';
import { audioComToPlayerTrack } from '@/components/custom/music/audiocom-tracks';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { FeaturedShareButton } from '@/components/custom/music/featured-share-button';
import { useLibrary } from '@/components/custom/music/library-context';
import {
  LibrarySearchResults,
  librarySearchCount,
} from '@/components/custom/music/library-search-results';
import { ListenInSolco } from '@/components/custom/music/listen-in-solco';
import { playHomeTrack, stationToTrack, videoToTrack } from '@/components/custom/music/live-tracks';
import {
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import { featuredDownloadTarget } from '@/components/custom/music/offline-download';
import { SingleOfflineDownloadButton } from '@/components/custom/music/offline-download-button';
import {
  describeYouTubeSearch,
  YOUTUBE_RETRY_DELAY_MS,
  YouTubeLinkOut,
  YouTubeSearchNoticeBox,
  type YouTubeSearchState,
  youtubeStatusText,
} from '@/components/custom/music/youtube-search-notice';
import { apiFetch } from '@/lib/api-client';
import type { AudioComTrack } from '@/lib/contracts/audiocom';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import {
  type LibrarySearchResponse,
  LibrarySearchResponseSchema,
} from '@/lib/contracts/library-search';
import type { AudiusTrackSearchResult, YouTubeVideoSearchResult } from '@/lib/contracts/music';
import {
  UNIFIED_AUDIOCOM_PARAM,
  UNIFIED_FEATURED_PARAM,
  type UnifiedResult,
  type UnifiedSearchResponse,
  UnifiedSearchResponseSchema,
} from '@/lib/contracts/unified-search';
import { audioComQualifiedId, isAudioComPlayable } from '@/lib/music/audiocom-license';
import { featuredArtistPath } from '@/lib/music/featured-artists';
import { genreCatalog, isPlaylistEntry } from '@/lib/music/genre-catalog';
import discover from './discover.module.css';
import styles from './unified-search-results.module.css';

type SearchError = { text: string; retryAfterMs: number };
/** `mine`: «Le tue», solo la sezione delle raccolte e dei brani della Libreria (chi ha l'accesso). */
type Filter = 'all' | 'mine' | 'tracks' | 'radio' | 'podcast';

const DEBOUNCE_MS = 350;
/** «Condividi» di un brano in evidenza: tondo come gli altri pulsanti della riga (36 px). */
const SEARCH_SHARE_BUTTON = 'size-9 rounded-full text-muted-foreground hover:text-foreground';
/** «Scarica offline» di un brano in evidenza: come «Condividi». */
const SEARCH_DOWNLOAD_BUTTON = 'size-9 rounded-full text-muted-foreground hover:text-foreground';

const SOURCE_LABEL: Record<UnifiedResult['kind'], string> = {
  featured: 'In evidenza',
  audius: 'Audius',
  audiocom: 'audio.com',
  youtube: 'YouTube',
  radio: 'Radio',
  podcast: 'Podcast',
};

function searchError(error: unknown): SearchError {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; message?: unknown; retryAfterSeconds?: unknown })
      : null;
  if (cause?.error === 'rate_limited') {
    const seconds =
      typeof cause.retryAfterSeconds === 'number' && cause.retryAfterSeconds > 0
        ? Math.min(cause.retryAfterSeconds, 120)
        : 10;
    return {
      text:
        typeof cause.message === 'string'
          ? cause.message
          : `Troppe ricerche ravvicinate. Riprova tra ${seconds} secondi.`,
      retryAfterMs: seconds * 1000,
    };
  }
  return { text: 'La ricerca non è riuscita. Riprova tra poco.', retryAfterMs: 0 };
}

function formatDuration(seconds: number | null | undefined) {
  if (!seconds) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Audius search track → player track (stesse scelte di audius-section, senza importarne il modulo). */
function audiusToPlayerTrack(track: AudiusTrackSearchResult): MusicPlayerTrack {
  return {
    qualifiedId: track.qualifiedId,
    title: track.title,
    artistName: track.artistName,
    artistUrl: track.artistUrl,
    artworkUrl: track.artworkUrl,
    sourceLabel: 'Audius',
    sourceUrl: track.trackUrl,
    sourceUrlLabel: 'Apri il brano su Audius',
    durationSeconds: track.durationSeconds,
    playbackMode: 'audius',
  };
}

/**
 * Dallo stato YouTube della risposta unificata all'avviso mostrato (riusa describeYouTubeSearch,
 * così il testo per ogni limite — personale / connessione / per tutti / occupato — è identico alla
 * ricerca per fonte). Null quando YouTube non è stato interrogato (mentre si digita).
 */
function youtubeState(response: UnifiedSearchResponse): YouTubeSearchState | null {
  if (!response.youtubeRequested) return null;
  const yt = response.sources.youtube;
  if (yt.status === 'skipped') return null;
  const outcome =
    yt.status === 'unavailable'
      ? 'unavailable'
      : yt.status === 'results'
        ? 'results'
        : 'no_results';
  return describeYouTubeSearch({
    outcome,
    videos: yt.videos,
    sourceStatus: {
      id: 'youtube',
      label: 'YouTube',
      active: yt.status !== 'unavailable',
      searchOutcome: outcome,
      summary: 'Ricerca YouTube.',
      prerequisite: 'YOUTUBE_DATA_API_KEY',
    },
    youtube: response.youtube,
  });
}

/** Brani: catalogo Solco in evidenza, Audius, audio.com e YouTube. */
function isTrackResult(result: UnifiedResult): boolean {
  return (
    result.kind === 'featured' ||
    result.kind === 'audius' ||
    result.kind === 'audiocom' ||
    result.kind === 'youtube'
  );
}

function matchesFilter(result: UnifiedResult, filter: Filter): boolean {
  if (filter === 'all') return true;
  // «Le tue» mostra solo la sezione della Libreria, nessuna voce dell'elenco misto.
  if (filter === 'mine') return false;
  if (filter === 'tracks') return isTrackResult(result);
  return result.kind === filter;
}

export function UnifiedSearchResults({
  initialQuery,
  initialAi = false,
}: {
  initialQuery: string;
  initialAi?: boolean;
}) {
  const player = useMusicPlayer();
  const router = useRouter();
  const pathname = usePathname();
  // Fuori dal provider (o senza sessione) è false: nessuna richiesta alla Libreria.
  const { signedIn } = useLibrary();

  const [draft, setDraft] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery.trim());
  // false mentre si digita (solo Audius + radio + podcast); true all'invio (aggiunge YouTube).
  const [youtubeRequested, setYoutubeRequested] = useState(false);
  // audio.com solo per una ricerca "completa" (link di ricerca o invio esplicito), mai mentre si
  // digita: il suo limite di richieste è condiviso da tutti gli ascoltatori di Solco.
  const [audiocomRequested, setAudiocomRequested] = useState(initialQuery.trim() !== '');
  // true dopo una risposta con audio.com `disconnected` (nessun account collegato dall'admin): il
  // suggerimento in cima smette di promettere risultati da audio.com.
  const [audiocomOff, setAudiocomOff] = useState(false);
  const [response, setResponse] = useState<UnifiedSearchResponse | null>(null);
  const [error, setError] = useState<SearchError | null>(null);
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  // Aumentato da «Riprova» per rieseguire la stessa ricerca.
  const [attempt, setAttempt] = useState(0);
  // «Le tue playlist»: raccolte e brani della Libreria di chi ha l'accesso (null = sezione nascosta).
  const [library, setLibrary] = useState<LibrarySearchResponse | null>(null);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInitial = useRef<string | null>(null);
  // Termine dell'ultimo invio esplicito: la navigazione (router.replace) che ne deriva cambia
  // `initialQuery` e rilancia l'effetto qui sotto, che NON deve azzerare il consenso YouTube appena
  // dato — altrimenti YouTube non comparirebbe mai per una query appena digitata.
  const submittedTerm = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Deep link (?q=…) o navigazione ESTERNA: riparte in modalità digitazione (niente YouTube finché
  // non si invia esplicitamente), così un link condiviso non consuma quota al caricamento. La
  // navigazione causata dal nostro stesso invio è riconosciuta dal termine inviato e lascia il
  // consenso come l'ha messo l'invio.
  useEffect(() => {
    if (lastInitial.current === initialQuery) return;
    lastInitial.current = initialQuery;
    setDraft(initialQuery);
    setQuery(initialQuery.trim());
    if (initialQuery.trim() === submittedTerm.current) {
      submittedTerm.current = null;
      return;
    }
    setYoutubeRequested(false);
    // Un link di ricerca è una ricerca completa: audio.com sì (YouTube no, costa quota).
    setAudiocomRequested(initialQuery.trim() !== '');
    setFilter('all');
  }, [initialQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt è un trigger di «Riprova».
  useEffect(() => {
    if (!query) {
      setResponse(null);
      setError(null);
      setPending(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    setError(null);
    const params = new URLSearchParams({ q: query });
    // YouTube costa quota (search.list = 100 unità): il consenso viaggia SOLO all'invio.
    if (youtubeRequested) params.set('youtubeConsent', 'accepted');
    // Questo client sa mostrare i brani in evidenza (tipo `featured`): il server li aggiunge solo così.
    params.set(UNIFIED_FEATURED_PARAM, '1');
    // audio.com (tipo `audiocom`) solo per le ricerche complete.
    if (audiocomRequested) params.set(UNIFIED_AUDIOCOM_PARAM, '1');
    apiFetch(`/api/music/search-all?${params.toString()}`, { schema: UnifiedSearchResponseSchema })
      .then((value) => {
        if (cancelled) return;
        setResponse(value);
        // Solo le risposte che includono audio.com dicono se è collegato.
        if (value.sources.audiocom)
          setAudiocomOff(value.sources.audiocom.status === 'disconnected');
        setPending(false);
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(searchError(reason));
        setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, youtubeRequested, audiocomRequested, attempt]);

  // «Le tue playlist»: SOLO per chi ha fatto l'accesso, in parallelo a search-all (che resta
  // pubblico e in cache CDN: i dati di un account arrivano solo da questo endpoint privato). Una
  // query nuova annulla la richiesta in volo; un errore (anche un 429) nasconde la sezione in
  // silenzio. L'invio con YouTube non cambia i risultati della Libreria: nessuna richiesta in più.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt è un trigger di «Riprova».
  useEffect(() => {
    if (!signedIn || !query) {
      setLibrary(null);
      return;
    }
    const controller = new AbortController();
    apiFetch(`/api/music/library/search?${new URLSearchParams({ q: query }).toString()}`, {
      schema: LibrarySearchResponseSchema,
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setLibrary(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLibrary(null);
      });
    return () => controller.abort();
  }, [query, signedIn, attempt]);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  const onType = (next: string) => {
    setDraft(next);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = null;
    const term = next.trim();
    if (!term) {
      // Campo svuotato: niente ricerca, niente richiesta in volo.
      setQuery('');
      setYoutubeRequested(false);
      setAudiocomRequested(false);
      return;
    }
    // Mentre si digita si cerca solo Audius + radio + podcast (gratis): YouTube (100 unità di quota
    // a ricerca) resta fuori finché non si preme Invio o «Cerca».
    debounce.current = setTimeout(() => {
      debounce.current = null;
      setYoutubeRequested(false);
      setAudiocomRequested(false);
      setQuery(term);
    }, DEBOUNCE_MS);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = null;
    const term = draft.trim().slice(0, 80);
    if (!term) return;
    // Ricorda il termine inviato: la navigazione che segue (router.replace cambia `initialQuery`)
    // rilancia l'effetto di reset, che altrimenti azzererebbe il consenso appena dato.
    submittedTerm.current = term;
    router.replace(`${pathname}?q=${encodeURIComponent(term)}`, { scroll: false });
    setYoutubeRequested(true);
    setAudiocomRequested(true);
    // Stesso testo già digitato: cambia youtubeRequested, quindi l'effetto rilancia con YouTube.
    setQuery(term);
  };

  const retry = () => {
    setAttempt((value) => value + 1);
    headingRef.current?.focus();
  };

  const results = response?.results ?? [];
  // Solo la risposta della query ATTUALE: mentre la Libreria cerca la query nuova, quella vecchia
  // (già arrivata) non resta a schermo né nei conteggi. La risposta porta la query ripulita.
  const currentLibrary = library && library.query === query ? library : null;
  const libraryCount = librarySearchCount(currentLibrary);
  const counts = useMemo(
    () => ({
      // «Tutto» conta anche la sezione della Libreria, che compare in cima.
      all: results.length + libraryCount,
      mine: libraryCount,
      tracks: results.filter(isTrackResult).length,
      radio: results.filter((r) => r.kind === 'radio').length,
      podcast: results.filter((r) => r.kind === 'podcast').length,
    }),
    [results, libraryCount],
  );
  // Se il filtro scelto è vuoto dopo una nuova risposta, mostra «Tutto» (niente lista vuota).
  const activeFilter: Filter = counts[filter] > 0 ? filter : 'all';
  const visible = useMemo(
    () => results.filter((result) => matchesFilter(result, activeFilter)),
    [results, activeFilter],
  );
  // La sezione «Le tue playlist» compare sotto «Tutto» e «Le tue», mai negli altri chip.
  const showLibrary = libraryCount > 0 && (activeFilter === 'all' || activeFilter === 'mine');
  const visibleCount = visible.length + (showLibrary ? libraryCount : 0);
  const librarySection =
    showLibrary && currentLibrary ? <LibrarySearchResults result={currentLibrary} /> : null;

  // Code del player per sorgente, così «brano successivo» resta nell'elenco mostrato.
  const featuredItems = useMemo(
    () => results.flatMap((r): HomeTrack[] => (r.kind === 'featured' ? [r.track] : [])),
    [results],
  );
  const audiusQueue = useMemo(
    () =>
      results
        .filter(
          (r): r is Extract<UnifiedResult, { kind: 'audius' }> =>
            r.kind === 'audius' && r.track.playbackEligible,
        )
        .map((r) => audiusToPlayerTrack(r.track)),
    [results],
  );
  const youtubeQueue = useMemo(
    () =>
      results
        .filter((r): r is Extract<UnifiedResult, { kind: 'youtube' }> => r.kind === 'youtube')
        .map((r) => videoToTrack(r.video)),
    [results],
  );
  // Solo i brani di audio.com riproducibili in Solco (licenza CC ammessa): mai gli altri.
  const audiocomQueue = useMemo(
    () =>
      results.flatMap((r): MusicPlayerTrack[] => {
        if (r.kind !== 'audiocom') return [];
        const track = audioComToPlayerTrack(r.track);
        return track ? [track] : [];
      }),
    [results],
  );
  const radioQueue = useMemo(
    () =>
      results
        .filter((r): r is Extract<UnifiedResult, { kind: 'radio' }> => r.kind === 'radio')
        .map((r) => stationToTrack(r.station)),
    [results],
  );

  const isActive = (qualifiedId: string) => player.currentTrack?.qualifiedId === qualifiedId;
  const isPlayingNow = (qualifiedId: string) =>
    isActive(qualifiedId) && (player.status === 'playing' || player.status === 'loading');

  const playTrack = (track: MusicPlayerTrack, queue: MusicPlayerTrack[]) => {
    if (isActive(track.qualifiedId)) {
      void player.togglePlayback();
      return;
    }
    const path = trackStreamPath(track);
    if (path) void player.playTrack(track, path, queue.length ? queue : [track]);
  };
  const playAudius = (track: AudiusTrackSearchResult) => {
    if (!track.playbackEligible) return;
    playTrack(audiusToPlayerTrack(track), audiusQueue);
  };
  // Brano in evidenza: lo STESSO avvio della Home (stesso elemento, stesso percorso, stesse regole
  // del player); la coda sono i brani in evidenza trovati.
  const playFeatured = (item: HomeTrack) => playHomeTrack(player, item, featuredItems);
  // audio.com: solo se la licenza lo permette (audioComToPlayerTrack restituisce null altrimenti).
  const playAudioCom = (item: AudioComTrack) => {
    const track = audioComToPlayerTrack(item);
    if (track) playTrack(track, audiocomQueue);
  };
  // Aprendo il player ufficiale di audio.com si mette in pausa quello di Solco (due brani insieme no).
  const pauseForEmbed = () => {
    if (player.status === 'playing') void player.togglePlayback();
  };

  const yt = response ? youtubeState(response) : null;
  const showNotice = yt?.kind === 'saved' || yt?.kind === 'blocked';
  const youtubeVideoCount = response?.sources.youtube.videos.length ?? 0;
  // audio.com chiesto ma senza risposta (limite, errore, tempo scaduto): lo si dice, con garbo.
  const audiocomNote =
    response?.sources.audiocom?.status === 'unavailable'
      ? 'audio.com non risponde in questo momento: riprova tra poco.'
      : null;

  // Riga di stato sempre montata (annunci per lo screen reader): conteggio della lista + stato YouTube.
  const statusLine = (() => {
    if (error) return error.text;
    if (pending && !response) return `Cerco “${query}”…`;
    if (pending && response) {
      return youtubeRequested ? `Cerco “${query}” anche su YouTube…` : `Aggiorno “${query}”…`;
    }
    if (!response) return '';
    const n = visibleCount;
    let line = `${n} ${n === 1 ? 'risultato' : 'risultati'} per “${response.query}”.`;
    if (yt && (yt.kind === 'saved' || yt.kind === 'blocked')) {
      line += ` ${youtubeStatusText(yt, youtubeVideoCount)}`;
    }
    if (audiocomNote) line += ` ${audiocomNote}`;
    return line;
  })();

  const filters: Array<{ value: Filter; label: string }> = [
    { value: 'all', label: 'Tutto' },
    { value: 'mine', label: 'Le tue' },
    { value: 'tracks', label: 'Brani' },
    { value: 'radio', label: 'Radio' },
    { value: 'podcast', label: 'Podcast' },
  ];

  return (
    <div className={discover.page}>
      <header>
        <h1 className={discover.pageTitle}>Cerca</h1>
        <p className={discover.lead}>
          Un solo campo per i brani in evidenza di Solco, brani, video, radio e podcast: i risultati
          arrivano insieme, ordinati e senza doppioni.
        </p>
      </header>

      <form className={discover.searchRow} onSubmit={submit}>
        <label className="sr-only" htmlFor="unified-query">
          Cerca brani, artisti, radio o podcast
        </label>
        <input
          id="unified-query"
          type="search"
          value={draft}
          maxLength={80}
          placeholder="Brani, artisti, radio, podcast"
          autoComplete="off"
          onChange={(event) => onType(event.target.value)}
        />
        <button type="submit" className={discover.searchButton} disabled={!draft.trim()}>
          <Search aria-hidden="true" />
          <span>Cerca</span>
        </button>
      </form>
      <p className={styles.hint}>
        Mentre scrivi cerchiamo fra i brani in evidenza, su Audius, radio e podcast. Premi Invio o
        «Cerca» per includere anche YouTube (la query raggiunge Google)
        {audiocomOff ? '.' : ' e audio.com.'}{' '}
        {signedIn ? 'Trovi anche le tue playlist e i brani salvati: li vedi solo tu. ' : null}
        <Link href="/privacy">Privacy</Link>
      </p>

      <AiMusicSearch initiallyOpen={initialAi} />
      <ListenInSolco />

      {!query ? (
        <section className={discover.section} aria-labelledby="unified-browse-heading">
          <header className={discover.sectionHeader}>
            <h2 id="unified-browse-heading">Sfoglia per genere e mood</h2>
          </header>
          <div className={discover.moodGrid}>
            {genreCatalog
              .filter((entry) => !isPlaylistEntry(entry))
              .slice(0, 16)
              .map((entry) => (
                <Link key={entry.slug} href={`/generi/${entry.slug}`}>
                  {entry.name}
                </Link>
              ))}
            <Link href="/generi">Tutti i generi e le playlist →</Link>
          </div>
        </section>
      ) : (
        <section className={discover.section} aria-labelledby="unified-results-heading">
          <div className={styles.resultsHeader}>
            <h2 id="unified-results-heading" ref={headingRef} tabIndex={-1}>
              Risultati
            </h2>
            {response && !pending ? (
              <span className={styles.count}>
                {visibleCount} {visibleCount === 1 ? 'risultato' : 'risultati'}
              </span>
            ) : null}
          </div>

          {/* Sempre montata, così lo screen reader annuncia ogni cambiamento (cerco, conteggio, avviso). */}
          <output className="sr-only" aria-live="polite">
            {statusLine}
          </output>

          {/* Solo per gli admin: in cima e fuori dai rami di search-all, così non sposta i risultati
              quando arrivano; mentre l'elenco vecchio resta a schermo, l'avviso non compare né
              sparisce (lo fa insieme ai risultati nuovi). */}
          <AdminSearchHint query={query} resultsUpdating={pending && response !== null} />

          {/* «Le tue playlist» non aspetta search-all: compare appena la Libreria risponde, anche
              mentre le altre fonti cercano o se la ricerca unificata non riesce. */}
          {error ? (
            <>
              {librarySection}
              <p className={discover.state}>{error.text}</p>
              <YouTubeLinkOut query={query} />
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={retry}
                style={{ marginTop: 8 }}
              >
                Riprova
              </button>
            </>
          ) : !response && pending ? (
            <>
              {librarySection}
              <p className={discover.state}>Cerco “{query}”…</p>
            </>
          ) : response ? (
            <>
              {showNotice && yt ? (
                <YouTubeSearchNoticeBox
                  query={response.query}
                  label={yt.kind === 'saved' ? yt.label : undefined}
                  text={yt.text}
                  quotaOut={yt.kind === 'blocked' ? yt.quotaOut : undefined}
                  signIn={yt.signIn}
                  onRetry={yt.retry ? retry : undefined}
                  retryDelayMs={YOUTUBE_RETRY_DELAY_MS}
                />
              ) : null}

              {audiocomNote ? <p className={styles.sourceNote}>{audiocomNote}</p> : null}

              {counts.all > 0 ? (
                <fieldset className={discover.chips}>
                  <legend className="sr-only">Filtra i risultati per tipo</legend>
                  {filters
                    .filter((item) => item.value === 'all' || counts[item.value] > 0)
                    .map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        aria-pressed={activeFilter === item.value}
                        onClick={() => setFilter(item.value)}
                      >
                        {item.label} <span>{counts[item.value]}</span>
                      </button>
                    ))}
                </fieldset>
              ) : null}

              {librarySection}

              {visible.length === 0 ? (
                showLibrary ? (
                  // Solo la sezione della Libreria: sotto «Tutto» si dice che altrove non c'è altro.
                  activeFilter === 'all' ? (
                    <p className={discover.state}>Nessun altro risultato per “{response.query}”.</p>
                  ) : null
                ) : (
                  <p className={discover.state}>
                    {counts.all === 0
                      ? `Nessun risultato per “${response.query}”.`
                      : 'Nessun risultato in questa categoria.'}
                  </p>
                )
              ) : (
                <ol className={discover.list}>
                  {visible.map((result) => (
                    <ResultRow
                      key={result.key}
                      result={result}
                      signedIn={signedIn}
                      isPlayingNow={isPlayingNow}
                      onPlayFeatured={playFeatured}
                      onPlayAudius={playAudius}
                      onPlayAudioCom={playAudioCom}
                      onOpenAudioComEmbed={pauseForEmbed}
                      onPlayVideo={(video) => playTrack(videoToTrack(video), youtubeQueue)}
                      onPlayStation={(station) => playTrack(stationToTrack(station), radioQueue)}
                    />
                  ))}
                </ol>
              )}
            </>
          ) : null}
        </section>
      )}
    </div>
  );
}

function SourceBadge({ kind }: { kind: UnifiedResult['kind'] }) {
  return (
    <span className={styles.badge} data-source={kind}>
      {SOURCE_LABEL[kind]}
    </span>
  );
}

function PlayButton({
  playing,
  label,
  onClick,
}: {
  playing: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${discover.iconButton} ${discover.playButton}`}
      onClick={onClick}
      aria-label={label}
    >
      {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
    </button>
  );
}

/** Lo stesso brano trovato anche su YouTube: azione secondaria sotto la voce, mai una riga a sé. */
function YouTubeAlternative({
  video,
  isPlayingNow,
  onPlayVideo,
}: {
  video: YouTubeVideoSearchResult;
  isPlayingNow: (qualifiedId: string) => boolean;
  onPlayVideo: (video: YouTubeVideoSearchResult) => void;
}) {
  // Suona nello stesso player: riflette lo stato come il pulsante primario.
  const playing = isPlayingNow(`youtube:${video.videoId}`);
  return (
    <div className={styles.secondary}>
      <button type="button" className={styles.secondaryBtn} onClick={() => onPlayVideo(video)}>
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{' '}
        {playing ? 'Metti in pausa su YouTube' : 'Ascolta su YouTube'}
      </button>
    </div>
  );
}

function ResultRow({
  result,
  signedIn,
  isPlayingNow,
  onPlayFeatured,
  onPlayAudius,
  onPlayAudioCom,
  onOpenAudioComEmbed,
  onPlayVideo,
  onPlayStation,
}: {
  result: UnifiedResult;
  /** false: «Scarica offline» spiega che serve accedere (il download richiede il login). */
  signedIn: boolean;
  isPlayingNow: (qualifiedId: string) => boolean;
  onPlayFeatured: (item: HomeTrack) => void;
  onPlayAudius: (track: AudiusTrackSearchResult) => void;
  onPlayAudioCom: (track: AudioComTrack) => void;
  onOpenAudioComEmbed: () => void;
  onPlayVideo: (video: YouTubeVideoSearchResult) => void;
  onPlayStation: (station: Extract<UnifiedResult, { kind: 'radio' }>['station']) => void;
}) {
  if (result.kind === 'featured') {
    const { track, youtubeAlternative } = result;
    // Stesso id del player della Home (homeTrackToTrack): `upload:<pathname>`.
    const playing = isPlayingNow(`upload:${track.id}`);
    const byline = track.artist ?? 'Solco';
    const stacked = youtubeAlternative ? ` ${styles.rowStacked}` : '';
    // «Scarica offline»: solo se il server ha detto che la copia offline è consentita (`offline`
    // true) e il brano ha il suo id opaco. Per ogni altra riga non cambia nulla.
    const download = featuredDownloadTarget(track);
    const downloadable = download ? ` ${styles.rowDownloadable}` : '';
    return (
      <li
        className={`${discover.row}${stacked}${downloadable}`}
        data-kind="featured"
        data-downloadable={download ? 'true' : undefined}
      >
        <div className={discover.rowArt}>
          <FallbackArt src={track.artworkUrl} label={track.title} size={104} />
        </div>
        <div className={styles.copy}>
          <div className={styles.titleLine}>
            <SourceBadge kind="featured" />
            <strong className={styles.title} title={track.title}>
              {track.title}
            </strong>
          </div>
          {/* Il nome porta alla pagina dell'artista solo se il server manda artistSlug (artista con
              almeno un brano dichiarato): mai un link a una pagina vuota. */}
          {track.artistSlug ? (
            <Link
              href={featuredArtistPath(track.artistSlug)}
              className={`${styles.sub} ${styles.artistLink}`}
              title={`Pagina di ${byline}`}
            >
              {byline}
            </Link>
          ) : (
            <span className={styles.sub}>{byline}</span>
          )}
          {youtubeAlternative ? (
            <YouTubeAlternative
              video={youtubeAlternative}
              isPlayingNow={isPlayingNow}
              onPlayVideo={onPlayVideo}
            />
          ) : null}
        </div>
        <div className={discover.rowActions}>
          {/* «Scarica offline» (salva il brano in «La tua musica»): accanto a «Condividi», mai
              dentro il pulsante che suona il brano. */}
          {download ? (
            <span className={styles.featuredDownload}>
              <SingleOfflineDownloadButton
                target={download}
                signedIn={signedIn}
                variant="ghost"
                iconOnly
                className={SEARCH_DOWNLOAD_BUTTON}
              />
            </span>
          ) : null}
          {/* Link diretto «Condividi»: solo per i brani dichiarati (il server manda shareId). */}
          <FeaturedShareButton
            track={track}
            className={styles.featuredShare}
            buttonClassName={SEARCH_SHARE_BUTTON}
          />
          <PlayButton
            playing={playing}
            label={
              playing
                ? `Metti in pausa ${track.title} di ${byline}`
                : `Riproduci ${track.title} di ${byline}`
            }
            onClick={() => onPlayFeatured(track)}
          />
        </div>
      </li>
    );
  }

  if (result.kind === 'audius') {
    const { track, youtubeAlternative } = result;
    const playing = isPlayingNow(track.qualifiedId);
    const stacked = youtubeAlternative ? ` ${styles.rowStacked}` : '';
    return (
      <li className={`${discover.row}${stacked}`}>
        <div className={discover.rowArt}>
          <FallbackArt src={track.artworkUrl} label={track.title} size={104} />
        </div>
        <div className={styles.copy}>
          <div className={styles.titleLine}>
            <SourceBadge kind="audius" />
            <strong className={styles.title} title={track.title}>
              {track.title}
            </strong>
          </div>
          <span className={styles.sub}>
            {[track.artistName, formatDuration(track.durationSeconds)].filter(Boolean).join(' · ')}
          </span>
          {/* Licenza OML §1.5: copyright (identifica l'artista), link alla licenza e al brano, come
              nella ricerca per fonte — un brano Audius non va riprodotto senza attribuzione. */}
          <AudiusLicenseNotice track={track} showTrackLink />
          {youtubeAlternative ? (
            <YouTubeAlternative
              video={youtubeAlternative}
              isPlayingNow={isPlayingNow}
              onPlayVideo={onPlayVideo}
            />
          ) : null}
        </div>
        <div className={discover.rowActions}>
          {track.playbackEligible ? (
            <PlayButton
              playing={playing}
              label={playing ? `Metti in pausa ${track.title}` : `Riproduci ${track.title}`}
              onClick={() => onPlayAudius(track)}
            />
          ) : null}
        </div>
      </li>
    );
  }

  if (result.kind === 'audiocom') {
    const { track, youtubeAlternative } = result;
    const playable = isAudioComPlayable(track);
    const playing = playable && isPlayingNow(audioComQualifiedId(track.id));
    return (
      <li className={`${discover.row} ${styles.rowStacked}`} data-kind="audiocom">
        <div className={discover.rowArt}>
          <FallbackArt src={track.imageUrl} label={track.title} size={104} />
        </div>
        <div className={styles.copy}>
          <div className={styles.titleLine}>
            <SourceBadge kind="audiocom" />
            <strong className={styles.title} title={track.title}>
              {track.title}
            </strong>
          </div>
          <span className={styles.sub}>
            {[track.authorName, formatDuration(track.durationSeconds)].filter(Boolean).join(' · ')}
          </span>
          {/* Attribuzione: licenza (link al testo per le CC) e link al brano su audio.com. */}
          <AudioComAttribution track={track} />
          {playable ? null : (
            // Licenza che Solco non riproduce: solo il player ufficiale di audio.com.
            <AudioComEmbedDialog track={track} onOpen={onOpenAudioComEmbed} />
          )}
          {youtubeAlternative ? (
            <YouTubeAlternative
              video={youtubeAlternative}
              isPlayingNow={isPlayingNow}
              onPlayVideo={onPlayVideo}
            />
          ) : null}
        </div>
        <div className={discover.rowActions}>
          {playable ? (
            <PlayButton
              playing={playing}
              label={
                playing
                  ? `Metti in pausa ${track.title} di ${track.authorName}`
                  : `Riproduci ${track.title} di ${track.authorName}`
              }
              onClick={() => onPlayAudioCom(track)}
            />
          ) : null}
        </div>
      </li>
    );
  }

  if (result.kind === 'youtube') {
    const { video } = result;
    const playing = isPlayingNow(`youtube:${video.videoId}`);
    return (
      <li className={discover.row}>
        <div className={discover.rowArt}>
          <FallbackArt src={video.thumbnailUrl} label={video.title} size={104} />
        </div>
        <div className={styles.copy}>
          <div className={styles.titleLine}>
            <SourceBadge kind="youtube" />
            <strong className={styles.title} title={video.title}>
              {video.title}
            </strong>
          </div>
          <span className={styles.sub}>{video.channelTitle}</span>
        </div>
        <div className={discover.rowActions}>
          <PlayButton
            playing={playing}
            label={playing ? `Metti in pausa ${video.title}` : `Riproduci ${video.title}`}
            onClick={() => onPlayVideo(video)}
          />
        </div>
      </li>
    );
  }

  if (result.kind === 'radio') {
    const { station } = result;
    const playing = isPlayingNow(`radio:${station.id}`);
    const meta = [station.country, station.tags[0]].filter(Boolean).join(' · ');
    return (
      <li className={discover.row}>
        <div className={discover.rowArt}>
          <FallbackArt src={station.artworkUrl} label={station.name} size={104} />
        </div>
        <div className={styles.copy}>
          <div className={styles.titleLine}>
            <SourceBadge kind="radio" />
            <strong className={styles.title} title={station.name}>
              {station.name}
            </strong>
          </div>
          <span className={styles.sub}>{meta || 'In diretta'}</span>
        </div>
        <div className={discover.rowActions}>
          <PlayButton
            playing={playing}
            label={
              playing ? `Metti in pausa ${station.name}` : `Ascolta ${station.name} in diretta`
            }
            onClick={() => onPlayStation(station)}
          />
        </div>
      </li>
    );
  }

  const { podcast } = result;
  const href = `/podcasts/${encodeURIComponent(podcast.id)}`;
  return (
    <li className={discover.row}>
      {/* Copertina non focalizzabile come nelle altre righe: la riga ha un'unica destinazione (il
          titolo) più una sola azione in coda, non tre link allo stesso indirizzo. */}
      <div className={discover.rowArt}>
        <FallbackArt src={podcast.artworkUrl} label={podcast.title} size={104} />
      </div>
      <div className={styles.copy}>
        <div className={styles.titleLine}>
          <SourceBadge kind="podcast" />
          <Link href={href} className={styles.title} title={podcast.title}>
            {podcast.title}
          </Link>
        </div>
        <span className={styles.sub}>{podcast.author ?? podcast.genre ?? 'Podcast'}</span>
      </div>
      <div className={discover.rowActions}>
        <Link href={href} className={discover.iconButton} aria-label={`Apri ${podcast.title}`}>
          <ListMusic aria-hidden="true" />
        </Link>
      </div>
    </li>
  );
}
