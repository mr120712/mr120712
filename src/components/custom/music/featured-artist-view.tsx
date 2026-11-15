// @polsia:user-owned — pagina d'artista dei "brani in evidenza" (/artista/<slug>): copertina a
// mosaico con le copertine dei suoi brani, nome, numero di brani, «Riproduci tutto» e «Casuale», e
// l'elenco dei brani (un tocco suona il brano, con la coda dell'artista). Mostra SOLO i brani con i
// diritti dichiarati in diritti.json (li filtra il server: GET /api/music/featured/artists/<slug>).
// La riproduzione è la stessa della Home (playHomeTrack: stesso elemento del player, stesso
// percorso di streaming, stesse regole). Stati: caricamento, nessun brano, errore con «Riprova».
// Ogni riga con `shareId` ha accanto il suo «Condividi» (link diretto /evidenza/<id>). Elenco,
// coda, link alla Home e scheletro sono condivisi con la pagina «Mostra tutti» di una sezione
// (featured-track-list.tsx).
'use client';

import { Mic2, Play, RotateCcw, Shuffle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  FeaturedBackLink,
  FeaturedListSkeleton,
  FeaturedTrackList,
  featuredLoadFailure,
  playFeaturedQueue,
  songCount,
} from '@/components/custom/music/featured-track-list';
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
import { isArtistSlug, shuffledCopy } from '@/lib/music/featured-artists';
import styles from './featured-artist-view.module.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: FeaturedArtistResponse }
  /** Nessun brano dichiarato per questo artista (o link non valido). */
  | { status: 'empty' }
  /** message: il testo del server per un limite raggiunto (429), se c'è. */
  | { status: 'error'; message: string | null };

/**
 * «Riproduci tutto» / «Casuale» della pagina d'artista: la coda dal primo brano (vedi
 * playFeaturedQueue, condivisa con la pagina di una sezione).
 */
export const playArtistQueue = playFeaturedQueue;

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
        const gone = featuredLoadFailure(error) === 'gone';
        setState(
          gone ? { status: 'empty' } : { status: 'error', message: serverLimitMessage(error) },
        );
      });
    return () => {
      active = false;
    };
  }, [slug, attempt]);

  if (state.status === 'loading') return <FeaturedListSkeleton label="Caricamento dell’artista…" />;

  if (state.status === 'empty') {
    return (
      <main className={styles.page}>
        <FeaturedBackLink />
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
        <FeaturedBackLink />
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

  return (
    <main className={styles.page}>
      <FeaturedBackLink />
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

      <FeaturedTrackList
        player={player}
        tracks={tracks}
        fallbackArtist={artist.name}
        headingId="artist-tracks-heading"
      />
    </main>
  );
}
