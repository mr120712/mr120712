// @polsia:user-owned — pagina d'artista dei "brani in evidenza" (/artista/<slug>): copertina a
// mosaico con le copertine dei suoi brani, nome, numero di brani, «Riproduci tutto» e «Casuale», e
// l'elenco dei brani (un tocco suona il brano, con la coda dell'artista). Mostra SOLO i brani con i
// diritti dichiarati in diritti.json (li filtra il server: GET /api/music/featured/artists/<slug>).
// La riproduzione è la stessa della Home (playHomeTrack: stesso elemento del player, stesso
// percorso di streaming, stesse regole). Stati: caricamento, nessun brano, errore con «Riprova».
// Ogni riga con `shareId` ha accanto il suo «Condividi» (link diretto /evidenza/<id>).
'use client';

import { ArrowLeft, Mic2, Pause, Play, RotateCcw, Shuffle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { FeaturedShareButton } from '@/components/custom/music/featured-share-button';
import { homeTrackToTrack, playHomeTrack } from '@/components/custom/music/live-tracks';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { PlaylistMosaic } from '@/components/custom/music/playlist-mosaic';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { serverLimitMessage } from '@/lib/business/api-error-message';
import {
  type FeaturedArtistResponse,
  FeaturedArtistResponseSchema,
  featuredArtistApiPath,
} from '@/lib/contracts/featured-artists';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import { isArtistSlug, shuffledCopy } from '@/lib/music/featured-artists';
import styles from './featured-artist-view.module.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: FeaturedArtistResponse }
  /** Nessun brano dichiarato per questo artista (o link non valido). */
  | { status: 'empty' }
  /** message: il testo del server per un limite raggiunto (429), se c'è. */
  | { status: 'error'; message: string | null };

/** Quanto serve del player (useMusicPlayer() lo soddisfa): lo stesso di playHomeTrack. */
type ArtistPlayer = Parameters<typeof playHomeTrack>[0];

/** «Condividi» di una riga: tondo, discreto, grande quanto l'icona di riproduzione. */
const ROW_SHARE_BUTTON = 'size-9 rounded-full text-muted-foreground hover:text-foreground';

function errorCode(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown })
      : null;
  return typeof cause?.error === 'string' ? cause.error : null;
}

function errorStatus(error: unknown) {
  const match = error instanceof Error ? /\((\d{3})\)$/.exec(error.message) : null;
  return match?.[1] ? Number(match[1]) : null;
}

function songCount(count: number) {
  return count === 1 ? '1 brano' : `${count} brani`;
}

/**
 * «Riproduci tutto» / «Casuale»: la coda dell'artista dal suo primo brano, con playHomeTrack come
 * in Home. Se il primo brano è già quello in corso, playHomeTrack lo metterebbe in pausa: qui
 * invece la coda riparte (stesso elemento e stesso percorso di playHomeTrack).
 */
export function playArtistQueue(player: ArtistPlayer, queue: readonly HomeTrack[]): void {
  const [first] = queue;
  if (!first) return;
  const track = homeTrackToTrack(first);
  if (player.currentTrack?.qualifiedId === track.qualifiedId) {
    void player.playTrack(track, track.streamUrl ?? '', queue.map(homeTrackToTrack));
    return;
  }
  playHomeTrack(player, first, queue);
}

function BackLink() {
  return (
    <Button asChild variant="ghost" size="sm" className={styles.back}>
      <Link href="/">
        <ArrowLeft aria-hidden="true" /> Torna alla Home
      </Link>
    </Button>
  );
}

function LoadingSkeleton() {
  return (
    <main className={styles.page} aria-busy="true">
      <BackLink />
      <output className="sr-only">Caricamento dell’artista…</output>
      <div className={styles.hero} aria-hidden="true">
        <div className={`${styles.skeleton} ${styles.skeletonCover}`} />
        <div className={styles.heroCopy}>
          <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
          <div className={`${styles.skeleton} ${styles.skeletonTitle}`} />
          <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
        </div>
      </div>
      <div className={styles.tracks} aria-hidden="true">
        {['a', 'b', 'c', 'd'].map((key) => (
          <div key={key} className={`${styles.skeleton} ${styles.skeletonRow}`} />
        ))}
      </div>
    </main>
  );
}

export function FeaturedArtistView({ slug }: { slug: string }) {
  const player = useMusicPlayer();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // «Riprova» smonta lo stato d'errore: quando arriva il nuovo stato, il titolo prende il focus.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeadingOnLoad = useRef(false);

  useEffect(() => {
    if (state.status === 'loading' || !focusHeadingOnLoad.current) return;
    focusHeadingOnLoad.current = false;
    headingRef.current?.focus();
  }, [state.status]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt è il trigger di «Riprova».
  useEffect(() => {
    if (!isArtistSlug(slug)) {
      setState({ status: 'empty' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    apiFetch(featuredArtistApiPath(slug), { schema: FeaturedArtistResponseSchema })
      .then((data) => {
        if (!active) return;
        setState(data.tracks.length > 0 ? { status: 'ready', data } : { status: 'empty' });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const gone = errorCode(error) === 'not_found' || errorStatus(error) === 404;
        setState(
          gone ? { status: 'empty' } : { status: 'error', message: serverLimitMessage(error) },
        );
      });
    return () => {
      active = false;
    };
  }, [slug, attempt]);

  if (state.status === 'loading') return <LoadingSkeleton />;

  if (state.status === 'empty') {
    return (
      <main className={styles.page}>
        <BackLink />
        <section className={styles.state}>
          <Mic2 aria-hidden="true" />
          <h1 ref={headingRef} tabIndex={-1}>
            Nessun brano disponibile
          </h1>
          <p>
            Per questo artista non ci sono brani in evidenza da ascoltare su Solco, oppure il link
            non è completo. In Home trovi tutti i brani in evidenza.
          </p>
          <Button asChild>
            <Link href="/">Vai alla Home</Link>
          </Button>
        </section>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className={styles.page}>
        <BackLink />
        <section className={styles.state} role="alert">
          <Mic2 aria-hidden="true" />
          <h1 ref={headingRef} tabIndex={-1}>
            Non riesco a caricare l’artista
          </h1>
          <p>{state.message ?? 'Controlla la connessione e riprova tra qualche istante.'}</p>
          <Button
            type="button"
            onClick={() => {
              focusHeadingOnLoad.current = true;
              setAttempt((value) => value + 1);
            }}
          >
            <RotateCcw aria-hidden="true" /> Riprova
          </Button>
        </section>
      </main>
    );
  }

  const { artist, tracks } = state.data;
  const nowPlaying =
    player.status === 'playing'
      ? tracks.find((track) => player.currentTrack?.qualifiedId === `upload:${track.id}`)
      : undefined;

  return (
    <main className={styles.page}>
      <BackLink />
      <header className={styles.hero}>
        {/* Le copertine dei suoi brani (dal più recente); senza copertine, l'iniziale del nome. */}
        <div className={styles.heroCover}>
          <PlaylistMosaic name={artist.name} items={tracks} />
        </div>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Artista · In evidenza</p>
          <h1 ref={headingRef} tabIndex={-1}>
            <bdi>{artist.name}</bdi>
          </h1>
          <p className={styles.count}>{songCount(tracks.length)}</p>
          <div className={styles.actions}>
            <Button type="button" onClick={() => playArtistQueue(player, tracks)}>
              <Play aria-hidden="true" /> Riproduci tutto
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={tracks.length < 2}
              onClick={() => playArtistQueue(player, shuffledCopy(tracks))}
            >
              <Shuffle aria-hidden="true" /> Casuale
            </Button>
          </div>
        </div>
      </header>

      <section className={styles.listSection} aria-labelledby="artist-tracks-heading">
        <div className={styles.listHeading}>
          <h2 id="artist-tracks-heading">Brani</h2>
          <p>{songCount(tracks.length)}</p>
        </div>
        {/* Safari/VoiceOver tolgono la semantica di lista a un elenco con list-style: none. */}
        {/* biome-ignore lint/a11y/noRedundantRoles: il ruolo esplicito tiene annunciato l'elenco. */}
        {/* biome-ignore lint/a11y/useSemanticElements: è già un <ol>; il ruolo è la correzione per Safari. */}
        <ol className={styles.tracks} role="list">
          {tracks.map((track, index) => {
            const current = player.currentTrack?.qualifiedId === `upload:${track.id}`;
            const playing = current && player.status === 'playing';
            const byline = track.artist ?? artist.name;
            const label = playing
              ? `Metti in pausa ${track.title} di ${byline}`
              : current
                ? `Riprendi ${track.title} di ${byline}`
                : `Riproduci ${track.title} di ${byline}`;
            return (
              <li
                key={track.id}
                className={styles.row}
                data-current={current ? 'true' : undefined}
                data-shareable={track.shareId ? 'true' : undefined}
              >
                <button
                  type="button"
                  className={styles.rowButton}
                  aria-label={label}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => playHomeTrack(player, track, tracks)}
                >
                  <span className={styles.index} aria-hidden="true">
                    {current ? (
                      <span className={styles.bars} data-playing={playing ? 'true' : undefined}>
                        <span />
                        <span />
                        <span />
                      </span>
                    ) : (
                      String(index + 1).padStart(2, '0')
                    )}
                  </span>
                  <span className={styles.cover}>
                    <FallbackArt src={track.artworkUrl} label={track.title} size={52} />
                  </span>
                  <span className={styles.copy}>
                    <strong title={track.title}>{track.title}</strong>
                    <span className={styles.trackArtist} title={byline}>
                      {byline}
                    </span>
                  </span>
                  <span className={styles.playIcon} aria-hidden="true">
                    {playing ? <Pause /> : <Play />}
                  </span>
                </button>
                {/* Link diretto «Condividi» (brani dichiarati): accanto alla riga, mai dentro il
                    pulsante che la suona. */}
                <FeaturedShareButton
                  track={track}
                  className={styles.rowShare}
                  buttonClassName={ROW_SHARE_BUTTON}
                />
              </li>
            );
          })}
        </ol>
        {/* Lo stato del brano in corso, annunciato quando cambia. */}
        <output className="sr-only" aria-live="polite">
          {nowPlaying ? `In riproduzione: ${nowPlaying.title}` : ''}
        </output>
      </section>
    </main>
  );
}
