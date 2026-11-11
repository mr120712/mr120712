// @polsia:user-owned
'use client';

import Image from 'next/image';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import {
  AudiusArtistCard,
  AudiusPlaylistCard,
  AudiusReleaseCard,
} from '@/components/custom/music/catalog-cards';
import { type MusicPlayerTrack, useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import {
  type AudiusTrackSearchResult,
  type MusicHomeResponse,
  MusicHomeResponseSchema,
  type MusicSearchSource,
} from '@/lib/contracts/music';
import { getAudiusPlaybackReasonText } from '@/lib/music/audius';
import { audiusGenres } from '@/lib/music/genres';
import styles from './home-catalog.module.css';

type HomeSectionOutcome = MusicHomeResponse['trending']['outcome'];

function stateCopy(
  outcome: HomeSectionOutcome | undefined,
  loading: boolean,
  failed: boolean,
  source: MusicSearchSource | undefined,
  section: string,
) {
  if (loading) return `Caricamento ${section} Audius…`;
  if (failed) return `I dati Audius per ${section} non sono disponibili in questo momento.`;
  if (outcome === 'unavailable') {
    return source?.unavailableReason === 'not_configured'
      ? 'Catalogo non disponibile: aggiungi AUDIUS_API_KEY nei segreti server-side.'
      : `Audius non ha restituito i dati per ${section}. Riprova più tardi.`;
  }
  if (outcome === 'no_results') return `Audius non ha restituito ${section} disponibili.`;
  return null;
}

function HomeSectionState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <output className={styles.sectionState} aria-live="polite">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Riprova
        </button>
      ) : null}
    </output>
  );
}

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

function HomeTrack({
  track,
  onPlay,
  isCurrentTrack,
  isPlaying,
  isLoading,
}: {
  track: MusicHomeResponse['trending']['tracks'][number];
  onPlay: () => void;
  isCurrentTrack: boolean;
  isPlaying: boolean;
  isLoading: boolean;
}) {
  return (
    <article className={styles.trackCard}>
      <a className={styles.trackArtwork} href={track.trackUrl} target="_blank" rel="noreferrer">
        <Image
          src={track.artworkUrl}
          alt={`Copertina di ${track.title}`}
          width={168}
          height={168}
          unoptimized
        />
      </a>
      <div className={styles.trackCopy}>
        <span className={styles.source}>Brano · Audius</span>
        <a className={styles.trackTitle} href={track.trackUrl} target="_blank" rel="noreferrer">
          {track.title}
        </a>
        <a className={styles.creator} href={track.artistUrl} target="_blank" rel="noreferrer">
          {track.artistName} · Profilo Audius
        </a>
        <AudiusLicenseNotice track={track} />
        {track.playbackEligible ? (
          <button className={styles.trackPlay} type="button" onClick={onPlay} disabled={isLoading}>
            {isCurrentTrack ? (isPlaying ? 'Pausa' : 'Riprendi') : 'Riproduci'}
          </button>
        ) : (
          <p className={styles.playbackUnavailable}>
            {getAudiusPlaybackReasonText(track.playbackReason)}
          </p>
        )}
      </div>
    </article>
  );
}

function resumableTrack(
  track: MusicPlayerTrack | null,
  status: ReturnType<typeof useMusicPlayer>['status'],
) {
  return track?.playbackMode !== undefined && ['paused', 'ended', 'error'].includes(status)
    ? track
    : null;
}

export function ResumeSection({
  track,
  onResume,
}: {
  track: MusicPlayerTrack;
  onResume: () => void;
}) {
  return (
    <section className={styles.resume} aria-labelledby="resume-title">
      <div className={styles.resumeIntro}>
        <p className={styles.eyebrow}>ASCOLTO CORRENTE · AUDIUS</p>
        <h2 id="resume-title">Riprendi</h2>
      </div>
      <article className={styles.resumeCard}>
        {track.artworkUrl ? (
          <Image
            src={track.artworkUrl}
            alt={`Copertina di ${track.title}`}
            width={72}
            height={72}
            unoptimized
          />
        ) : null}
        <div className={styles.resumeCopy}>
          <strong className={styles.resumeTitle}>{track.title}</strong>
          {track.artistUrl ? (
            <a
              className={styles.resumeAttribution}
              href={track.artistUrl}
              target="_blank"
              rel="noreferrer"
            >
              {track.artistName} · Profilo Audius
            </a>
          ) : (
            <span className={styles.resumeAttribution}>{track.artistName}</span>
          )}
        </div>
        <button type="button" onClick={onResume}>
          Riprendi
        </button>
      </article>
    </section>
  );
}

export function HomeCatalog({ afterCharts }: { afterCharts?: ReactNode } = {}) {
  const player = useMusicPlayer();
  const [response, setResponse] = useState<MusicHomeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const resume = resumableTrack(player.currentTrack, player.status);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const value = await apiFetch('/api/music/home', { schema: MusicHomeResponseSchema });
      setResponse(value);
    } catch {
      setFailed(true);
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const sourceStatus = response?.sourceStatus;
  const trendingTracks = response?.trending.tracks ?? [];
  const playableQueue = trendingTracks.filter((track) => track.playbackEligible).map(toPlayerTrack);
  const playTrendingTrack = (track: AudiusTrackSearchResult) => {
    if (!track.playbackEligible) return;
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    void player.playTrack(
      toPlayerTrack(track),
      `/api/music/audius/tracks/${encodeURIComponent(track.id)}/stream`,
      playableQueue,
    );
  };
  const trendingMessage = stateCopy(
    response?.trending.outcome,
    loading,
    failed,
    sourceStatus,
    'le tendenze',
  );
  const releaseMessage = stateCopy(
    response?.releases.outcome,
    loading,
    failed,
    sourceStatus,
    'le nuove uscite',
  );
  const playlistMessage = stateCopy(
    response?.playlists.outcome,
    loading,
    failed,
    sourceStatus,
    'le playlist',
  );
  const artistMessage = stateCopy(
    response?.artists.outcome,
    loading,
    failed,
    sourceStatus,
    'gli artisti',
  );

  return (
    <div className={styles.catalog}>
      {resume ? (
        <ResumeSection track={resume} onResume={() => void player.togglePlayback()} />
      ) : null}

      <section className={styles.section} id="tendenze" aria-labelledby="trending-heading">
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>CLASSIFICHE · AUDIUS</p>
            <h2 id="trending-heading">Top in classifica</h2>
          </div>
          <Link href="/search?q=Electronic">Cerca su Audius</Link>
        </header>
        {trendingMessage ? (
          <HomeSectionState
            message={trendingMessage}
            onRetry={failed ? () => void loadCatalog() : undefined}
          />
        ) : (
          <div className={styles.trackGrid}>
            {trendingTracks.map((track) => (
              <HomeTrack
                key={track.qualifiedId}
                track={track}
                onPlay={() => playTrendingTrack(track)}
                isCurrentTrack={player.currentTrack?.qualifiedId === track.qualifiedId}
                isPlaying={player.status === 'playing'}
                isLoading={player.status === 'loading'}
              />
            ))}
          </div>
        )}
      </section>

      {afterCharts}

      <section className={styles.section} id="nuove-uscite" aria-labelledby="releases-heading">
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>CATALOGO · AUDIUS</p>
            <h2 id="releases-heading">Nuove uscite</h2>
          </div>
        </header>
        {releaseMessage ? (
          <HomeSectionState
            message={releaseMessage}
            onRetry={failed ? () => void loadCatalog() : undefined}
          />
        ) : (
          <div className={styles.releaseGrid}>
            {response?.releases.albums.map((release) => (
              <AudiusReleaseCard key={release.id} release={release} />
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} id="playlist" aria-labelledby="playlists-heading">
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>SELEZIONI · AUDIUS</p>
            <h2 id="playlists-heading">Playlist da esplorare</h2>
            <p className={styles.sectionNote}>
              Playlist trovate nel catalogo Audius cercando Electronic.
            </p>
          </div>
        </header>
        {playlistMessage ? (
          <HomeSectionState
            message={playlistMessage}
            onRetry={failed ? () => void loadCatalog() : undefined}
          />
        ) : (
          <div className={styles.releaseGrid}>
            {response?.playlists.playlists.map((playlist) => (
              <AudiusPlaylistCard key={playlist.qualifiedId} playlist={playlist} />
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} id="artisti" aria-labelledby="artists-heading">
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>PROFILI · AUDIUS</p>
            <h2 id="artists-heading">Artisti da scoprire</h2>
            <p className={styles.sectionNote}>Profili Audius trovati cercando Electronic.</p>
          </div>
        </header>
        {artistMessage ? (
          <HomeSectionState
            message={artistMessage}
            onRetry={failed ? () => void loadCatalog() : undefined}
          />
        ) : (
          <div className={styles.artistGrid}>
            {response?.artists.artists.map((artist) => (
              <AudiusArtistCard key={artist.qualifiedId} artist={artist} />
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} id="generi" aria-labelledby="genres-heading">
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>GENERI E MOOD</p>
            <h2 id="genres-heading">Scegli una direzione</h2>
            <p className={styles.sectionNote}>Ogni scelta avvia una ricerca sul catalogo Audius.</p>
          </div>
        </header>
        <ul className={styles.genreGrid}>
          {audiusGenres.map((genre, index) => (
            <li key={genre.id}>
              <Link href={`/search?q=${encodeURIComponent(genre.query)}`}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{genre.label}</strong>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
