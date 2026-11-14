// @polsia:user-owned — pagina pubblica del link diretto di un brano in evidenza (/evidenza/<id>):
// copertina grande, titolo, artista (link alla sua pagina se c'è), «Riproduci» e «Condividi». I
// dati arrivano da GET /api/music/featured/tracks/<id> (solo brani DICHIARATI in diritti.json).
// - Con una sessione l'API manda anche il brano da ascoltare: «Riproduci» lo suona con
//   playHomeTrack (stesso elemento del player, stesso percorso e stesse regole della Home). Nessun
//   avvio automatico: i browser lo bloccano, si parte con un tocco.
// - Senza sessione: «Accedi per ascoltare», che dopo l'accesso torna qui (destinazione verificata
//   con isSafeAuthDestination).
// «Condividi» ripropone lo stesso link con la sua scheda JPEG. Stati: caricamento, brano non
// disponibile (404: id sconosciuto, non valido o non dichiarato, tutti uguali), errore con «Riprova».
// La richiesta parte quando la sessione è nota e si ripete se cambia (accesso/uscita).
'use client';

import { LogIn, Music2, Pause, Play, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { playHomeTrack } from '@/components/custom/music/live-tracks';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { ShareMenu } from '@/components/custom/share-menu';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { serverLimitMessage } from '@/lib/business/api-error-message';
import { isSafeAuthDestination } from '@/lib/business/auth-form';
import { publicShareUrl } from '@/lib/business/social-share';
import {
  type FeaturedShareResponse,
  FeaturedShareResponseSchema,
} from '@/lib/contracts/featured-share';
import { featuredArtistPath } from '@/lib/music/featured-artists';
import {
  featuredShareApiPath,
  featuredShareImagePath,
  featuredSharePath,
  featuredShareText,
  featuredShareTitle,
  isFeaturedShareId,
} from '@/lib/music/featured-share';
import styles from './featured-share-view.module.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: FeaturedShareResponse }
  /** Id sconosciuto, non valido o di un brano non dichiarato: stessa risposta. */
  | { status: 'not_found' }
  /** message: il testo del server per un limite raggiunto (429), se c'è. */
  | { status: 'error'; message: string | null };

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

/** /login che dopo l'accesso torna a questo brano (se la destinazione è accettata). */
export function featuredShareLoginHref(shareId: string): string {
  const destination = featuredSharePath(shareId);
  return isSafeAuthDestination(destination)
    ? `/login?callbackURL=${encodeURIComponent(destination)}`
    : '/login';
}

function LoadingSkeleton() {
  return (
    <main className={styles.page} aria-busy="true">
      <output className="sr-only">Caricamento del brano…</output>
      <div className={styles.hero} aria-hidden="true">
        <div className={`${styles.skeleton} ${styles.skeletonCover}`} />
        <div className={styles.copy}>
          <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
          <div className={`${styles.skeleton} ${styles.skeletonTitle}`} />
          <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
        </div>
      </div>
    </main>
  );
}

export function FeaturedShareView({ shareId }: { shareId: string }) {
  const player = useMusicPlayer();
  const { data: session, isPending: sessionPending } = useSession();
  // La sessione nota (o null finché la si verifica): cambia all'accesso o all'uscita.
  const sessionKey = sessionPending ? null : (session?.user?.id ?? '');
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
    if (!isFeaturedShareId(shareId)) {
      setState({ status: 'not_found' });
      return;
    }
    // Finché la sessione è in verifica non si chiede nulla: la risposta dipende da lei.
    if (sessionKey === null) return;
    let active = true;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    apiFetch(featuredShareApiPath(shareId), { schema: FeaturedShareResponseSchema })
      .then((data) => {
        if (active) setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const gone = errorCode(error) === 'not_found' || errorStatus(error) === 404;
        setState(
          gone ? { status: 'not_found' } : { status: 'error', message: serverLimitMessage(error) },
        );
      });
    return () => {
      active = false;
    };
  }, [shareId, attempt, sessionKey]);

  if (state.status === 'loading') return <LoadingSkeleton />;

  if (state.status === 'not_found') {
    return (
      <main className={styles.page}>
        <section className={styles.state}>
          <Music2 aria-hidden="true" />
          <h1 ref={headingRef} tabIndex={-1}>
            Questo brano non è disponibile
          </h1>
          <p>
            Il link non è completo, oppure il brano non è più in evidenza su Solco. Su Solco trovi
            comunque brani, radio e podcast da ascoltare.
          </p>
          <Button asChild>
            <Link href="/">Scopri Solco</Link>
          </Button>
        </section>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className={styles.page}>
        <section className={styles.state} role="alert">
          <Music2 aria-hidden="true" />
          <h1 ref={headingRef} tabIndex={-1}>
            Non riesco a caricare il brano
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

  const { track, homeTrack } = state.data;
  const current = Boolean(
    homeTrack && player.currentTrack?.qualifiedId === `upload:${homeTrack.id}`,
  );
  const playing = current && player.status === 'playing';
  const byline = track.artist ?? 'Solco';
  const playLabel = playing
    ? `Metti in pausa ${track.title} di ${byline}`
    : current
      ? `Riprendi ${track.title} di ${byline}`
      : `Riproduci ${track.title} di ${byline}`;

  return (
    <main className={styles.page}>
      <article className={styles.hero} aria-labelledby="featured-share-title">
        <div className={styles.cover} data-current={current ? 'true' : undefined}>
          <FallbackArt src={track.coverPath} label={track.title} size={480} />
        </div>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>In evidenza su Solco</p>
          <h1 id="featured-share-title" ref={headingRef} tabIndex={-1}>
            <bdi>{track.title}</bdi>
          </h1>
          {track.artist ? (
            track.artistSlug ? (
              <Link
                href={featuredArtistPath(track.artistSlug)}
                className={`${styles.artist} ${styles.artistLink}`}
                title={`Pagina di ${track.artist}`}
              >
                <bdi>{track.artist}</bdi>
              </Link>
            ) : (
              <p className={styles.artist}>
                <bdi>{track.artist}</bdi>
              </p>
            )
          ) : null}
          <div className={styles.actions}>
            {homeTrack ? (
              <Button
                type="button"
                size="lg"
                className={styles.primary}
                aria-label={playLabel}
                aria-pressed={current ? playing : undefined}
                onClick={() => playHomeTrack(player, homeTrack, [homeTrack])}
              >
                {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                {playing ? 'Pausa' : current ? 'Riprendi' : 'Riproduci'}
              </Button>
            ) : (
              <Button asChild size="lg" className={styles.primary}>
                <Link href={featuredShareLoginHref(shareId)}>
                  <LogIn aria-hidden="true" /> Accedi per ascoltare
                </Link>
              </Button>
            )}
            <ShareMenu
              label="Condividi"
              ariaLabel={`Condividi ${track.title}`}
              title={featuredShareTitle(track.title)}
              text={featuredShareText(track.title, track.artist)}
              url={publicShareUrl(featuredSharePath(shareId))}
              imageUrl={featuredShareImagePath(shareId)}
            />
          </div>
          {homeTrack ? null : (
            <p className={styles.note}>
              Per ascoltare serve un account gratuito: dopo l’accesso torni qui, a questo brano.
            </p>
          )}
        </div>
      </article>
      {/* Lo stato del brano, annunciato quando cambia. */}
      <output className="sr-only" aria-live="polite">
        {playing ? `In riproduzione: ${track.title}` : ''}
      </output>
    </main>
  );
}
