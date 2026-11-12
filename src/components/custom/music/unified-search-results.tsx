// @polsia:user-owned — Cerca unificata: UN solo campo interroga Audius, radio e podcast mentre si
// digita (gratis, nessuna chiamata a YouTube) e aggiunge YouTube solo all'invio esplicito (Invio o
// «Cerca»), senza mai bruciare la quota mentre si scrive. Mostra UN elenco misto, deduplicato e
// ordinato per rilevanza con un piccolo distintivo di fonte per riga; ogni riga suona nel player
// Solco. Quando la quota YouTube è finita resta l'avviso con i risultati salvati e il link «Cerca
// su YouTube» (riusa youtube-search-notice). Chip-filtro opzionali (Tutto / Brani / Radio /
// Podcast) restringono lo stesso elenco. Consuma UnifiedSearchResponseSchema via apiFetch.
'use client';

import { ListMusic, Pause, Play, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { AiMusicSearch } from '@/components/custom/music/ai-music-search';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { ListenInSolco } from '@/components/custom/music/listen-in-solco';
import { stationToTrack, videoToTrack } from '@/components/custom/music/live-tracks';
import {
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import {
  describeYouTubeSearch,
  YOUTUBE_RETRY_DELAY_MS,
  YouTubeLinkOut,
  YouTubeSearchNoticeBox,
  type YouTubeSearchState,
  youtubeStatusText,
} from '@/components/custom/music/youtube-search-notice';
import { apiFetch } from '@/lib/api-client';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import {
  type UnifiedResult,
  type UnifiedSearchResponse,
  UnifiedSearchResponseSchema,
} from '@/lib/contracts/unified-search';
import { genreCatalog } from '@/lib/music/genre-catalog';
import discover from './discover.module.css';
import styles from './unified-search-results.module.css';

type SearchError = { text: string; retryAfterMs: number };
type Filter = 'all' | 'tracks' | 'radio' | 'podcast';

const DEBOUNCE_MS = 350;

const SOURCE_LABEL: Record<UnifiedResult['kind'], string> = {
  audius: 'Audius',
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

function matchesFilter(result: UnifiedResult, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'tracks') return result.kind === 'audius' || result.kind === 'youtube';
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

  const [draft, setDraft] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery.trim());
  // false mentre si digita (solo Audius + radio + podcast); true all'invio (aggiunge YouTube).
  const [youtubeRequested, setYoutubeRequested] = useState(false);
  const [response, setResponse] = useState<UnifiedSearchResponse | null>(null);
  const [error, setError] = useState<SearchError | null>(null);
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  // Aumentato da «Riprova» per rieseguire la stessa ricerca.
  const [attempt, setAttempt] = useState(0);

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
    apiFetch(`/api/music/search-all?${params.toString()}`, { schema: UnifiedSearchResponseSchema })
      .then((value) => {
        if (cancelled) return;
        setResponse(value);
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
  }, [query, youtubeRequested, attempt]);

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
      return;
    }
    // Mentre si digita si cerca solo Audius + radio + podcast (gratis): YouTube (100 unità di quota
    // a ricerca) resta fuori finché non si preme Invio o «Cerca».
    debounce.current = setTimeout(() => {
      debounce.current = null;
      setYoutubeRequested(false);
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
    // Stesso testo già digitato: cambia youtubeRequested, quindi l'effetto rilancia con YouTube.
    setQuery(term);
  };

  const retry = () => {
    setAttempt((value) => value + 1);
    headingRef.current?.focus();
  };

  const results = response?.results ?? [];
  const counts = useMemo(
    () => ({
      all: results.length,
      tracks: results.filter((r) => r.kind === 'audius' || r.kind === 'youtube').length,
      radio: results.filter((r) => r.kind === 'radio').length,
      podcast: results.filter((r) => r.kind === 'podcast').length,
    }),
    [results],
  );
  // Se il filtro scelto è vuoto dopo una nuova risposta, mostra «Tutto» (niente lista vuota).
  const activeFilter: Filter = counts[filter] > 0 ? filter : 'all';
  const visible = useMemo(
    () => results.filter((result) => matchesFilter(result, activeFilter)),
    [results, activeFilter],
  );

  // Code del player per sorgente, così «brano successivo» resta nell'elenco mostrato.
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

  const yt = response ? youtubeState(response) : null;
  const showNotice = yt?.kind === 'saved' || yt?.kind === 'blocked';
  const youtubeVideoCount = response?.sources.youtube.videos.length ?? 0;

  // Riga di stato sempre montata (annunci per lo screen reader): conteggio della lista + stato YouTube.
  const statusLine = (() => {
    if (error) return error.text;
    if (pending && !response) return `Cerco “${query}”…`;
    if (pending && response) {
      return youtubeRequested ? `Cerco “${query}” anche su YouTube…` : `Aggiorno “${query}”…`;
    }
    if (!response) return '';
    const n = visible.length;
    let line = `${n} ${n === 1 ? 'risultato' : 'risultati'} per “${response.query}”.`;
    if (yt && (yt.kind === 'saved' || yt.kind === 'blocked')) {
      line += ` ${youtubeStatusText(yt, youtubeVideoCount)}`;
    }
    return line;
  })();

  const filters: Array<{ value: Filter; label: string }> = [
    { value: 'all', label: 'Tutto' },
    { value: 'tracks', label: 'Brani' },
    { value: 'radio', label: 'Radio' },
    { value: 'podcast', label: 'Podcast' },
  ];

  return (
    <div className={discover.page}>
      <header>
        <h1 className={discover.pageTitle}>Cerca</h1>
        <p className={discover.lead}>
          Un solo campo per brani, video, radio e podcast: i risultati arrivano insieme, ordinati e
          senza doppioni.
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
        Mentre scrivi cerchiamo su Audius, radio e podcast. Premi Invio o «Cerca» per includere
        anche YouTube (la query raggiunge Google). <Link href="/privacy">Privacy</Link>
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
              .filter((entry) => entry.family !== 'playlist')
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
                {visible.length} {visible.length === 1 ? 'risultato' : 'risultati'}
              </span>
            ) : null}
          </div>

          {/* Sempre montata, così lo screen reader annuncia ogni cambiamento (cerco, conteggio, avviso). */}
          <output className="sr-only" aria-live="polite">
            {statusLine}
          </output>

          {error ? (
            <>
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
            <p className={discover.state}>Cerco “{query}”…</p>
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

              {visible.length === 0 ? (
                <p className={discover.state}>
                  {counts.all === 0
                    ? `Nessun risultato per “${response.query}”.`
                    : 'Nessun risultato in questa categoria.'}
                </p>
              ) : (
                <ol className={discover.list}>
                  {visible.map((result) => (
                    <ResultRow
                      key={result.key}
                      result={result}
                      isPlayingNow={isPlayingNow}
                      onPlayAudius={playAudius}
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

function ResultRow({
  result,
  isPlayingNow,
  onPlayAudius,
  onPlayVideo,
  onPlayStation,
}: {
  result: UnifiedResult;
  isPlayingNow: (qualifiedId: string) => boolean;
  onPlayAudius: (track: AudiusTrackSearchResult) => void;
  onPlayVideo: (video: Extract<UnifiedResult, { kind: 'youtube' }>['video']) => void;
  onPlayStation: (station: Extract<UnifiedResult, { kind: 'radio' }>['station']) => void;
}) {
  if (result.kind === 'audius') {
    const { track, youtubeAlternative } = result;
    const playing = isPlayingNow(track.qualifiedId);
    // L'alternativa su YouTube suona nello stesso player: riflette lo stato come il pulsante primario.
    const altPlaying = youtubeAlternative
      ? isPlayingNow(`youtube:${youtubeAlternative.videoId}`)
      : false;
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
            <div className={styles.secondary}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => onPlayVideo(youtubeAlternative)}
              >
                {altPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{' '}
                {altPlaying ? 'Metti in pausa su YouTube' : 'Ascolta su YouTube'}
              </button>
            </div>
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
