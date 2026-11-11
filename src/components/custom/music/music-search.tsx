// @polsia:user-owned
'use client';

import { Search } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlbumCard } from '@/components/custom/music/album-card';
import { AudiusArtistCard, AudiusPlaylistCard } from '@/components/custom/music/catalog-cards';
import { type MusicPlayerTrack, useMusicPlayer } from '@/components/custom/music/music-player';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/business/api-error-message';
import {
  type AudiusTrackSearchResult,
  CollectionMutationResponseSchema,
  type MusicCollection,
  MusicCollectionsSchema,
  type MusicSearchResponse,
  MusicSearchResponseSchema,
  type MusicSearchSource,
  MusicSourceStatusListSchema,
  type MusicTrendingResponse,
  MusicTrendingResponseSchema,
} from '@/lib/contracts/music';
import { getAudiusPlaybackReasonText } from '@/lib/music/audius';
import { audiusGenres } from '@/lib/music/genres';
import styles from './music.module.css';
import { YouTubeQueuePlayer } from './youtube-queue-player';
import { YouTubeVideoCard } from './youtube-video-card';

type Source = 'audius' | 'youtube';
type AudiusCategory = 'all' | 'tracks' | 'artists' | 'playlists';

function statusMessage(source: MusicSearchSource | undefined) {
  if (!source) return 'Controllo dello stato delle fonti…';
  if (source.unavailableReason === 'not_configured') return source.prerequisite;
  if (source.unavailableReason === 'quota_exceeded') {
    return 'Quota YouTube Data API v3 esaurita. Solco non inventa risultati né ripete la richiesta automaticamente.';
  }
  if (source.unavailableReason === 'api_error') {
    return 'La fonte ha restituito un errore. Riprova con un nuovo invio della query.';
  }
  if (source.id === 'audius' && source.searchOutcome === 'unavailable') {
    return source.retryAfterSeconds
      ? `Audius ha limitato le richieste. Riprova tra ${source.retryAfterSeconds} secondi.`
      : 'Audius ha restituito un errore o una risposta non disponibile.';
  }
  return source.active ? source.summary : source.prerequisite;
}

function requestErrorMessage(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; message?: unknown; retryAfterSeconds?: unknown })
      : null;
  if (cause?.error === 'rate_limited') {
    if (typeof cause.message === 'string') return cause.message;
    return `Ricerca temporaneamente limitata. Riprova tra ${String(cause.retryAfterSeconds ?? 1)} secondi.`;
  }
  if (cause?.error === 'youtube_consent_required') {
    return 'Consenti l’invio della query a YouTube prima di cercare.';
  }
  return 'La richiesta di ricerca è terminata con un errore. Nessun risultato è stato aggiunto.';
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function AudiusResult({
  track,
  onPlay,
  isCurrentTrack,
  isPlaying,
  isLoading,
  onFavorite,
  playlists,
  selectedPlaylistId,
  onAddToPlaylist,
}: {
  track: AudiusTrackSearchResult;
  onPlay: () => void;
  isCurrentTrack: boolean;
  isPlaying: boolean;
  isLoading: boolean;
  onFavorite: (source: Source, sourceId: string) => void;
  playlists: MusicCollection[];
  selectedPlaylistId: string;
  onAddToPlaylist: (source: Source, sourceId: string) => void;
}) {
  return (
    <article className={styles.resultCard}>
      <div className={styles.artwork}>
        <Image
          src={track.artworkUrl}
          alt={`Copertina di ${track.title}`}
          width={96}
          height={96}
          unoptimized
        />
      </div>
      <div className={styles.resultContent}>
        <div className={styles.resultHeading}>
          <div>
            <span className={styles.sourcePill}>Solco · Audius</span>
            <h3>{track.title}</h3>
            <p className={styles.artistLine}>
              <a href={track.artistUrl} target="_blank" rel="noreferrer">
                {track.artistName}
              </a>
              <span> · @{track.artistHandle}</span>
              {formatDuration(track.durationSeconds) ? (
                <span> · {formatDuration(track.durationSeconds)}</span>
              ) : null}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onFavorite('audius', track.id)}
          >
            Salva nei preferiti
          </Button>
        </div>
        <div className={styles.attribution}>
          <span>{track.licensorName ?? 'Licenziante non indicato da Audius'}</span>
          {track.copyrightNotice ? <span>{track.copyrightNotice}</span> : null}
          {track.license ? <span>Licenza: {track.license}</span> : null}
          <a href={track.trackUrl} target="_blank" rel="noreferrer">
            Brano originale su Audius
          </a>
          <a href={track.artistUrl} target="_blank" rel="noreferrer">
            Profilo artista Audius
          </a>
        </div>
        {track.playbackEligible ? (
          <Button type="button" variant="secondary" size="sm" onClick={onPlay} disabled={isLoading}>
            {isCurrentTrack ? (isPlaying ? 'Pausa' : 'Riprendi') : 'Riproduci su Solco'}
          </Button>
        ) : (
          <p className={styles.playbackBlocked}>
            {getAudiusPlaybackReasonText(track.playbackReason)} Nessun audio parte finché Audius non
            conferma lo stream.
          </p>
        )}
        {playlists.length ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!selectedPlaylistId}
            onClick={() => onAddToPlaylist('audius', track.id)}
          >
            Aggiungi alla playlist
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function MusicSearch({
  initialQuery = '',
  extras,
}: {
  initialQuery?: string;
  /** Extra result sections (radio, podcast) for the last submitted query. */
  extras?: (searchedQuery: string) => ReactNode;
}) {
  const player = useMusicPlayer();
  const [source, setSource] = useState<Source>('audius');
  const [query, setQuery] = useState(initialQuery);
  const [youtubeConsent, setYoutubeConsent] = useState(false);
  const [statuses, setStatuses] = useState<MusicSearchSource[]>([]);
  const [resultsBySource, setResultsBySource] = useState<
    Partial<Record<Source, MusicSearchResponse>>
  >({});
  const [sourceErrors, setSourceErrors] = useState<Partial<Record<Source, string>>>({});
  const [searchedSources, setSearchedSources] = useState<Source[]>([]);
  const [searchedQuery, setSearchedQuery] = useState('');
  const [trending, setTrending] = useState<MusicTrendingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [youtubeQueueIndex, setYoutubeQueueIndex] = useState<number | null>(null);
  const [collections, setCollections] = useState<MusicCollection[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('');
  const [category, setCategory] = useState<AudiusCategory>('all');
  const requestSequence = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInitialQuery = useRef('');

  const executeSearch = useCallback(
    async (term: string, includeYouTube: boolean, requestedBy: Source) => {
      const normalizedTerm = term.trim();
      if (!normalizedTerm) {
        setMessage('Inserisci una query prima di avviare la ricerca.');
        return;
      }
      if (requestedBy === 'youtube' && !includeYouTube) {
        setMessage('Conferma l’invio della query a YouTube prima di cercare.');
        return;
      }

      const requestId = ++requestSequence.current;
      const requestedSources: Source[] = includeYouTube ? ['audius', 'youtube'] : [requestedBy];
      setLoading(true);
      setMessage(null);
      setYoutubeQueueIndex(null);
      setTrending(null);
      setResultsBySource({});
      setSourceErrors({});
      setSearchedSources(requestedSources);
      setSearchedQuery(normalizedTerm);

      const settled = await Promise.all(
        requestedSources.map(async (requestedSource) => {
          const params = new URLSearchParams({ source: requestedSource, q: normalizedTerm });
          if (requestedSource === 'youtube') params.set('youtubeConsent', 'accepted');
          try {
            const response = await apiFetch(`/api/music/search?${params.toString()}`, {
              schema: MusicSearchResponseSchema,
            });
            return { source: requestedSource, response } as const;
          } catch (error) {
            return { source: requestedSource, error: requestErrorMessage(error) } as const;
          }
        }),
      );

      if (requestId !== requestSequence.current) return;

      const nextResults: Partial<Record<Source, MusicSearchResponse>> = {};
      const nextErrors: Partial<Record<Source, string>> = {};
      for (const item of settled) {
        if ('response' in item) nextResults[item.source] = item.response;
        else nextErrors[item.source] = item.error;
      }
      setResultsBySource(nextResults);
      setSourceErrors(nextErrors);
      setStatuses((current) =>
        current.map((item) =>
          nextResults[item.id] ? (nextResults[item.id]?.sourceStatus ?? item) : item,
        ),
      );
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    void apiFetch('/api/music/source-status', { schema: MusicSourceStatusListSchema })
      .then((value) => setStatuses(value.sources))
      .catch(() => setMessage('Non è stato possibile leggere lo stato delle fonti.'));
    void apiFetch('/api/music/collections', { schema: MusicCollectionsSchema })
      .then((value) => {
        setCollections(value.collections);
        setSelectedPlaylistId(value.collections.find((item) => item.kind === 'playlist')?.id ?? '');
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const term = initialQuery.trim();
    if (term === lastInitialQuery.current) return;
    lastInitialQuery.current = term;
    if (!term) return;
    setQuery(term);
    setSource('audius');
    setCategory('all');
    void executeSearch(term, false, 'audius');
  }, [executeSearch, initialQuery]);

  useEffect(
    () => () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    },
    [],
  );

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = null;
    await executeSearch(query, youtubeConsent, source);
  }

  async function loadTrending() {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = null;
    const requestId = ++requestSequence.current;
    setLoading(true);
    setMessage(null);
    setResultsBySource({});
    setSourceErrors({});
    setSearchedQuery('');
    setSearchedSources([]);
    try {
      const response = await apiFetch('/api/music/trending', {
        schema: MusicTrendingResponseSchema,
      });
      if (requestId !== requestSequence.current) return;
      setTrending(response);
      setStatuses((current) =>
        current.map((item) => (item.id === 'audius' ? response.sourceStatus : item)),
      );
      if (response.outcome === 'inactive') setMessage(response.sourceStatus.prerequisite);
      else if (response.outcome === 'no_results')
        setMessage('Audius non ha restituito tendenze disponibili.');
      else if (response.outcome === 'unavailable') setMessage(statusMessage(response.sourceStatus));
      else if (response.outcome === 'partial')
        setMessage('Tendenze parziali: una parte dei dati Audius non è disponibile.');
    } catch {
      if (requestId === requestSequence.current) {
        setMessage('La richiesta delle tendenze è terminata con un errore.');
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }

  async function addFavorite(itemSource: Source, sourceId: string) {
    try {
      const saved = await apiFetch('/api/music/collections', {
        method: 'POST',
        body: JSON.stringify({ action: 'favorite', source: itemSource, sourceId }),
        schema: CollectionMutationResponseSchema,
      });
      setCollections(saved.collections);
      toast.success('Aggiunto ai preferiti.');
    } catch (error) {
      const cause =
        error instanceof Error && typeof error.cause === 'object' && error.cause !== null
          ? (error.cause as { error?: unknown })
          : null;
      if (cause?.error === 'Unauthorized')
        toast.error('Accedi per salvare gli elementi nei preferiti.');
      else
        toast.error(
          apiErrorMessage(
            error,
            'Impossibile salvare questo elemento. La fonte deve confermare i metadati.',
          ),
        );
    }
  }

  async function addToPlaylist(itemSource: Source, sourceId: string) {
    if (!selectedPlaylistId) {
      toast.error('Crea prima una playlist dal tuo spazio personale.');
      return;
    }
    try {
      const saved = await apiFetch('/api/music/collections', {
        method: 'POST',
        body: JSON.stringify({
          action: 'add',
          collectionId: selectedPlaylistId,
          source: itemSource,
          sourceId,
        }),
        schema: CollectionMutationResponseSchema,
      });
      setCollections(saved.collections);
      toast.success('Aggiunto alla playlist.');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Impossibile aggiungere questo elemento alla playlist.'));
    }
  }

  const activeStatus = statuses.find((item) => item.id === source);
  const currentResult = resultsBySource[source];
  const tracks = trending && source === 'audius' ? trending.tracks : (currentResult?.tracks ?? []);
  const albums = trending && source === 'audius' ? trending.albums : (currentResult?.albums ?? []);
  const artists = currentResult?.artists ?? [];
  const playlists = currentResult?.playlists ?? [];
  const videos = currentResult?.videos ?? [];
  const queuedVideo = youtubeQueueIndex === null ? undefined : videos[youtubeQueueIndex];
  const solcoAudioActive = player.status === 'playing' || player.status === 'loading';
  const pauseSolcoAudio = () => {
    if (player.status === 'playing') void player.togglePlayback();
  };
  const playableAudiusQueue: MusicPlayerTrack[] = tracks
    .filter((track) => track.playbackEligible)
    .map((track) => ({
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
    }));
  const playAudiusTrack = (track: AudiusTrackSearchResult) => {
    if (!track.playbackEligible) return;
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const selectedTrack = playableAudiusQueue.find(
      (item) => item.qualifiedId === track.qualifiedId,
    );
    if (!selectedTrack) return;
    void player.playTrack(
      selectedTrack,
      `/api/music/audius/tracks/${encodeURIComponent(track.id)}/stream`,
      playableAudiusQueue,
    );
  };
  const partialSearch =
    searchedSources.length > 1 &&
    searchedSources.some(
      (requestedSource) =>
        sourceErrors[requestedSource] ||
        resultsBySource[requestedSource]?.outcome === 'unavailable' ||
        resultsBySource[requestedSource]?.outcome === 'inactive',
    ) &&
    searchedSources.some((requestedSource) =>
      ['results', 'partial'].includes(resultsBySource[requestedSource]?.outcome ?? ''),
    );
  const noResultsInSources =
    searchedSources.length > 0 &&
    searchedSources.every(
      (requestedSource) => resultsBySource[requestedSource]?.outcome === 'no_results',
    );
  const currentMessage =
    sourceErrors[source] ??
    (searchedQuery && !searchedSources.includes(source)
      ? source === 'youtube' && !youtubeConsent
        ? 'Consenti l’invio della query per cercare su YouTube mantenendo lo stesso testo.'
        : 'Questa fonte non è stata interrogata per la query corrente.'
      : currentResult?.outcome === 'unavailable'
        ? statusMessage(currentResult.sourceStatus)
        : currentResult?.outcome === 'no_results'
          ? 'Nessun risultato restituito da questa fonte.'
          : currentResult?.outcome === 'partial'
            ? 'Risposta parziale: una parte dei risultati Audius non è disponibile.'
            : currentResult?.outcome === 'inactive'
              ? currentResult.sourceStatus.prerequisite
              : message);

  return (
    <main className={styles.page}>
      <div className={styles.topline}>
        <p className={styles.eyebrow}>SOLCO · RICERCA MUSICALE</p>
        <Link href="/library">Preferiti e playlist</Link>
      </div>
      <h1 className={styles.title}>Cerca musica su Solco.</h1>
      <p className={styles.lead}>
        Usa un solo campo per cercare brani, artisti e playlist Audius o video musicali su YouTube.
        La query raggiunge YouTube solo dopo il tuo consenso.
      </p>

      <div className={styles.tabs} role="tablist" aria-label="Fonte musicale">
        <button
          id="music-tab-solco"
          type="button"
          role="tab"
          aria-controls="music-panel"
          aria-selected={source === 'audius'}
          onClick={() => setSource('audius')}
        >
          Solco <span>(Audius)</span>
        </button>
        <button
          id="music-tab-youtube"
          type="button"
          role="tab"
          aria-controls="music-panel"
          aria-selected={source === 'youtube'}
          onClick={() => setSource('youtube')}
        >
          YouTube
        </button>
      </div>

      <section className={styles.sourceStatus} aria-live="polite">
        <div className={styles.statusHeading}>
          <span className={activeStatus?.active ? styles.statusActive : styles.statusInactive} />
          <strong>
            {activeStatus?.active
              ? 'Fonte configurata'
              : source === 'youtube'
                ? 'Fonte non configurata'
                : 'Fonte non configurata'}
          </strong>
        </div>
        <p>{statusMessage(activeStatus)}</p>
        {source === 'youtube' ? (
          <p className={styles.policyNote}>
            La query viene inviata solo dopo il consenso esplicito. Scegliendo un video, Solco usa
            soltanto il player ufficiale YouTube visibile e mette in coda gli altri risultati.
          </p>
        ) : null}
      </section>

      <section className={styles.searchPanel}>
        <form onSubmit={(event) => void submitSearch(event)}>
          <label htmlFor="music-query">Cerca un titolo o un artista</label>
          <div className={styles.searchRow}>
            <div className={styles.inputWrap}>
              <Search aria-hidden="true" />
              <input
                id="music-query"
                name="q"
                value={query}
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  if (debounceTimer.current) clearTimeout(debounceTimer.current);
                  debounceTimer.current = null;
                  requestSequence.current += 1;
                  setQuery(nextQuery);
                  setCategory('all');
                  setLoading(false);
                  setResultsBySource({});
                  setYoutubeQueueIndex(null);
                  setSourceErrors({});
                  setSearchedQuery('');
                  setSearchedSources([]);
                  setTrending(null);
                  setMessage(null);
                  if (nextQuery.trim()) {
                    debounceTimer.current = setTimeout(() => {
                      debounceTimer.current = null;
                      // While typing only Audius is searched (free). Each YouTube search costs
                      // 100 of the 10,000 daily quota units, and partial words would use them up:
                      // YouTube is searched only on submit (Enter or "Cerca").
                      void executeSearch(
                        nextQuery,
                        false,
                        source === 'youtube' ? 'audius' : source,
                      );
                    }, 350);
                  }
                }}
                maxLength={80}
                placeholder="Es. Khruangbin, The Cure…"
                autoComplete="off"
              />
            </div>
            <Button type="submit" disabled={loading || (source === 'youtube' && !youtubeConsent)}>
              {loading ? 'Attendi…' : 'Cerca'}
            </Button>
          </div>
          <div className={styles.consent}>
            <label htmlFor="youtube-consent">
              <input
                id="youtube-consent"
                type="checkbox"
                checked={youtubeConsent}
                onChange={(event) => {
                  setYoutubeConsent(event.target.checked);
                  if (!event.target.checked) {
                    setResultsBySource((current) => ({ audius: current.audius }));
                    setSourceErrors((current) => ({ audius: current.audius }));
                    setSearchedSources((current) => current.filter((item) => item === 'audius'));
                    setYoutubeQueueIndex(null);
                  }
                }}
              />
              Invia la stessa query a YouTube Data API v3 e mostra i risultati nella relativa
              scheda.
            </label>
            <p>
              Senza consenso, Solco interroga soltanto la fonte selezionata. Mentre scrivi vedi i
              risultati Audius; YouTube viene cercato quando premi Invio o «Cerca». La ricerca
              YouTube usa una cache breve; non archivia audio o video.
            </p>
            <div>
              <Link href="/terms">Termini</Link>
              <Link href="/privacy">Privacy</Link>
            </div>
          </div>
          {source === 'audius' ? (
            <button
              className={styles.trendingButton}
              type="button"
              onClick={() => void loadTrending()}
              disabled={loading}
            >
              Mostra tendenze Audius
            </button>
          ) : null}
          {collections.some((item) => item.kind === 'playlist') ? (
            <div className={styles.playlistPicker}>
              <label htmlFor="target-playlist">Playlist per i risultati</label>
              <select
                id="target-playlist"
                value={selectedPlaylistId}
                onChange={(event) => setSelectedPlaylistId(event.target.value)}
              >
                {collections
                  .filter((item) => item.kind === 'playlist')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </div>
          ) : null}
        </form>
      </section>

      <section className={styles.genreSection} aria-labelledby="search-genres-heading">
        <h2 id="search-genres-heading">Esplora per genere</h2>
        <div className={styles.genreChips}>
          {audiusGenres.map((genre) => (
            <Link key={genre.id} href={`/search?q=${encodeURIComponent(genre.query)}`}>
              {genre.label}
            </Link>
          ))}
        </div>
      </section>

      {partialSearch ? (
        <output className={styles.stateMessage}>
          Risultati parziali: una fonte ha restituito risultati e un’altra non è disponibile.
        </output>
      ) : null}
      {noResultsInSources ? (
        <output className={styles.stateMessage}>Nessun risultato nelle fonti cercate.</output>
      ) : null}
      {currentMessage ? <output className={styles.stateMessage}>{currentMessage}</output> : null}

      <section
        id="music-panel"
        className={styles.results}
        role="tabpanel"
        aria-labelledby={source === 'audius' ? 'music-tab-solco' : 'music-tab-youtube'}
      >
        {loading ? (
          <output className={styles.loadingMessage} aria-live="polite">
            Cerco “{searchedQuery || query.trim()}” su {source === 'audius' ? 'Audius' : 'YouTube'}…
          </output>
        ) : null}
        {searchedQuery ? (
          <p className={styles.queryCaption}>
            Risultati per <strong>“{searchedQuery}”</strong>
          </p>
        ) : null}
        {currentResult?.outcome === 'results' ||
        currentResult?.outcome === 'partial' ||
        trending?.outcome === 'results' ||
        albums.length > 0 ? (
          <>
            <div className={styles.resultsHeading}>
              <h2>
                {source === 'youtube'
                  ? 'Video trovati'
                  : trending
                    ? 'Tendenze Audius'
                    : 'Risultati Audius'}
              </h2>
              <span className={styles.resultsSource}>
                {source === 'youtube' ? 'Fonte: YouTube' : 'Fonte: Solco · Audius'}
              </span>
            </div>
            {source === 'youtube' ? (
              <>
                {queuedVideo && youtubeQueueIndex !== null ? (
                  <YouTubeQueuePlayer
                    items={videos}
                    index={youtubeQueueIndex}
                    onIndexChange={setYoutubeQueueIndex}
                    onClose={() => setYoutubeQueueIndex(null)}
                    onPlaying={pauseSolcoAudio}
                    pauseRequested={solcoAudioActive}
                  />
                ) : null}
                {videos.map((video, videoIndex) => (
                  <YouTubeVideoCard
                    key={video.videoId}
                    video={video}
                    inlinePlayer={false}
                    onFavorite={() => void addFavorite('youtube', video.videoId)}
                    onAddToPlaylist={() => void addToPlaylist('youtube', video.videoId)}
                    hasPlaylists={collections.some((item) => item.kind === 'playlist')}
                    selected={queuedVideo?.videoId === video.videoId}
                    onSelect={() => setYoutubeQueueIndex(videoIndex)}
                  />
                ))}
              </>
            ) : (
              <>
                <fieldset className={styles.categoryTabs}>
                  <legend className="sr-only">Categorie dei risultati Audius</legend>
                  {(
                    [
                      ['all', 'Tutti'],
                      ['tracks', 'Brani'],
                      ['artists', 'Artisti'],
                      ['playlists', 'Playlist'],
                    ] as const
                  ).map(([value, label]) => {
                    const count =
                      value === 'tracks'
                        ? tracks.length
                        : value === 'artists'
                          ? artists.length
                          : value === 'playlists'
                            ? playlists.length
                            : tracks.length + artists.length + playlists.length + albums.length;
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={category === value}
                        onClick={() => setCategory(value)}
                      >
                        {label} <span>{count}</span>
                      </button>
                    );
                  })}
                </fieldset>
                {albums.length && category === 'all' ? (
                  <div className={styles.albumResults}>
                    <h3>Album dal catalogo</h3>
                    <div className={styles.albumGrid}>
                      {albums.map((album) => (
                        <AlbumCard key={album.id} album={album} />
                      ))}
                    </div>
                  </div>
                ) : null}
                {category === 'all' || category === 'tracks'
                  ? tracks.map((track) => (
                      <AudiusResult
                        key={track.id}
                        track={track}
                        onPlay={() => playAudiusTrack(track)}
                        isCurrentTrack={player.currentTrack?.qualifiedId === track.qualifiedId}
                        isPlaying={player.status === 'playing'}
                        isLoading={player.status === 'loading'}
                        onFavorite={addFavorite}
                        playlists={collections.filter((item) => item.kind === 'playlist')}
                        selectedPlaylistId={selectedPlaylistId}
                        onAddToPlaylist={addToPlaylist}
                      />
                    ))
                  : null}
                {category === 'all' || category === 'artists' ? (
                  artists.length ? (
                    <div className={styles.catalogResultGrid}>
                      {artists.map((artist) => (
                        <AudiusArtistCard key={artist.qualifiedId} artist={artist} />
                      ))}
                    </div>
                  ) : category === 'artists' ? (
                    <p className={styles.categoryEmpty}>
                      Nessun artista trovato in questa ricerca.
                    </p>
                  ) : null
                ) : null}
                {category === 'all' || category === 'playlists' ? (
                  playlists.length ? (
                    <div className={styles.catalogResultGrid}>
                      {playlists.map((playlist) => (
                        <AudiusPlaylistCard key={playlist.qualifiedId} playlist={playlist} />
                      ))}
                    </div>
                  ) : category === 'playlists' ? (
                    <p className={styles.categoryEmpty}>
                      Nessuna playlist trovata in questa ricerca.
                    </p>
                  ) : null
                ) : null}
              </>
            )}
          </>
        ) : null}
      </section>

      <section className={styles.queueState} aria-live="polite">
        <span>
          Player corrente:{' '}
          {player.currentTrack
            ? `${player.currentTrack.title} · ${player.currentTrack.sourceLabel}`
            : 'nessun brano Audius in riproduzione'}
        </span>
        {player.errorMessage ? <p>{player.errorMessage}</p> : null}
      </section>

      {extras && searchedQuery ? extras(searchedQuery) : null}
    </main>
  );
}
