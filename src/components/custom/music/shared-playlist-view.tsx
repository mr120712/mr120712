// @polsia:user-owned — pagina pubblica di una playlist condivisa (/playlist/<id>): chiunque abbia
// il link vede nome, prima parola del nome del proprietario e brani, e li ascolta nel player Solco
// (stesse regole di ascolto della Libreria, verificate dalle route di stream). Chi ha un account
// può salvarne una copia nella propria Libreria.
'use client';

import { Check, ListMusic, LogIn, Pause, Play, Plus, RotateCcw, Shuffle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import {
  collectionItemQualifiedId,
  collectionItemToTrack,
  collectionQueue,
  isCollectionItemCurrent,
  playCollectionItem,
  playCollectionQueue,
} from '@/components/custom/music/collection-tracks';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { ShareButton } from '@/components/custom/share-button';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { apiErrorMessage, serverLimitMessage } from '@/lib/business/api-error-message';
import {
  SaveSharedPlaylistResponseSchema,
  type SharedPlaylist,
  type SharedPlaylistItem,
  SharedPlaylistSchema,
} from '@/lib/contracts/shared-playlist';
import { artInitial } from '@/lib/music/art-initial';
import { isolateName, isShareId, sharedPlaylistPath } from '@/lib/music/playlist-share';
import styles from './shared-playlist.module.css';

/** Focusable while busy or waiting for the session (aria-disabled, never disabled). */
const WAITING_BUTTON = 'aria-disabled:cursor-progress aria-disabled:opacity-60';
const NEW_TAB_HINT = ' (si apre in una nuova scheda)';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; playlist: SharedPlaylist }
  | { status: 'not_found' }
  /** message: the server's Italian wording of a reached limit (429), if any. */
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

function songCount(count: number) {
  return count === 1 ? '1 brano' : `${count} brani`;
}

/**
 * "il 10 novembre 2026", but "il 1º novembre" (ordinal for the first of the month) and
 * "l’8 dicembre", "l’11 novembre" (elided before a vowel sound).
 */
function updatedOn(iso: string) {
  const date = new Date(iso);
  if (date.getDate() === 1) {
    return `il 1º ${date.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}`;
  }
  const formatted = date.toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const day = date.getDate();
  return `${day === 8 || day === 11 ? 'l’' : 'il '}${formatted}`;
}

function duration(seconds: number | null) {
  if (!seconds || seconds <= 0) return null;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function itemTitle(item: SharedPlaylistItem) {
  if (item.title) return item.title;
  return item.source === 'youtube' ? 'Video YouTube' : 'Brano non disponibile';
}

function sourceBadge(item: SharedPlaylistItem) {
  if (item.source === 'youtube') return 'YouTube';
  if (item.source === 'audius') return 'Audius';
  return 'Brano';
}

function unavailableReason(item: SharedPlaylistItem) {
  if (item.source === 'youtube') return 'I dettagli di questo video non sono più disponibili.';
  if (item.source === 'audius')
    return 'Audius non ha confermato i dati completi: il brano non parte.';
  return 'Questo brano non può essere avviato.';
}

function Mosaic({ playlist }: { playlist: SharedPlaylist }) {
  const covers = [
    ...new Set(playlist.items.flatMap((item) => (item.artworkUrl ? [item.artworkUrl] : []))),
  ];
  const shown = covers.length >= 4 ? covers.slice(0, 4) : covers.slice(0, 1);
  if (shown.length === 0) {
    return (
      <div className={`${styles.mosaic} ${styles.mosaicFallback}`} aria-hidden="true">
        {artInitial(playlist.name)}
      </div>
    );
  }
  return (
    <div className={styles.mosaic} data-count={shown.length} aria-hidden="true">
      {shown.map((src) => (
        <FallbackArt
          key={src}
          src={src}
          label={playlist.name}
          size={shown.length === 4 ? 160 : 320}
        />
      ))}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <main className={styles.page} aria-busy="true">
      <output className="sr-only">Caricamento della playlist…</output>
      <div className={styles.hero} aria-hidden="true">
        <div className={`${styles.skeleton} ${styles.skeletonCover}`} />
        <div className={styles.heroCopy}>
          <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ width: '8rem' }} />
          <div className={`${styles.skeleton} ${styles.skeletonTitle}`} />
          <div className={`${styles.skeleton} ${styles.skeletonLine}`} style={{ width: '12rem' }} />
        </div>
      </div>
      <div className={styles.tracks} aria-hidden="true">
        {['a', 'b', 'c', 'd', 'e'].map((key) => (
          <div key={key} className={`${styles.skeleton} ${styles.skeletonRow}`} />
        ))}
      </div>
    </main>
  );
}

export function SharedPlaylistView({ shareId }: { shareId: string }) {
  const player = useMusicPlayer();
  const { data: session, isPending: sessionPending } = useSession();
  const signedIn = Boolean(session?.user);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // "Salva" turns into a link once saved: the focus follows it instead of dropping to <body>.
  const savedLinkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (saved) savedLinkRef.current?.focus();
  }, [saved]);
  // Signed out, the stream routes refuse every play: a tap on play asks to sign in instead.
  const signedOut = !sessionPending && !signedIn;
  const [authPromptRequest, setAuthPromptRequest] = useState(0);
  const authPromptRef = useRef<HTMLElement>(null);
  // "Riprova" unmounts with the error state: once the new state settles, its h1 takes the focus.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeadingOnLoad = useRef(false);

  useEffect(() => {
    if (state.status === 'loading' || !focusHeadingOnLoad.current) return;
    focusHeadingOnLoad.current = false;
    headingRef.current?.focus();
  }, [state.status]);

  // Each tap (also from a row far down the list) moves focus to the prompt and scrolls to it.
  useEffect(() => {
    if (authPromptRequest > 0) authPromptRef.current?.focus();
  }, [authPromptRequest]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an explicit retry trigger.
  useEffect(() => {
    if (!isShareId(shareId)) {
      setState({ status: 'not_found' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    apiFetch(`/api/music/shared/${encodeURIComponent(shareId)}`, { schema: SharedPlaylistSchema })
      .then((playlist) => {
        if (active) setState({ status: 'ready', playlist });
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
  }, [shareId, attempt]);

  if (state.status === 'loading') return <LoadingSkeleton />;

  if (state.status === 'not_found') {
    return (
      <main className={styles.page}>
        <section className={styles.state}>
          <ListMusic aria-hidden="true" />
          <h1 ref={headingRef} tabIndex={-1}>
            Questa playlist non è più condivisa
          </h1>
          <p>
            Chi l’ha creata ha smesso di condividerla, oppure il link non è completo. Su Solco trovi
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
          <ListMusic aria-hidden="true" />
          <h1 ref={headingRef} tabIndex={-1}>
            Non riesco a caricare la playlist
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

  const { playlist } = state;
  const queue = collectionQueue(playlist.items);
  const callback = encodeURIComponent(sharedPlaylistPath(shareId));
  const loginHref = `/login?callbackURL=${callback}`;
  const signupHref = `/signup?callbackURL=${callback}`;

  /**
   * Starts the shared player, or (signed out) shows the sign-in prompt that comes back here.
   * While the session is still being checked nothing starts: the stream would answer 401.
   */
  function play(start: () => void) {
    if (sessionPending) return;
    if (signedOut) {
      setAuthPromptRequest((value) => value + 1);
      return;
    }
    start();
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const result = await apiFetch(`/api/music/shared/${encodeURIComponent(shareId)}/save`, {
        method: 'POST',
        body: '{}',
        schema: SaveSharedPlaylistResponseSchema,
      });
      setSaved(true);
      toast.success(`“${isolateName(result.name)}” è nella tua Libreria.`);
    } catch (error) {
      if (errorStatus(error) === 401) toast.error('Accedi per salvare la playlist.');
      else if (errorCode(error) === 'own_playlist')
        toast('Questa playlist è già nella tua Libreria.');
      else if (errorCode(error) === 'not_found')
        toast.error('Questa playlist non è più condivisa.');
      else
        toast.error(apiErrorMessage(error, 'Non è stato possibile salvare la playlist. Riprova.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <Mosaic playlist={playlist} />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Playlist condivisa</p>
          <h1 ref={headingRef} tabIndex={-1}>
            {playlist.name}
          </h1>
          <p className={styles.byline}>
            <span>
              di{' '}
              <strong>
                <bdi>{playlist.owner}</bdi>
              </strong>
            </span>
            <span>{songCount(playlist.itemCount)}</span>
          </p>
          <div className={styles.actions}>
            {signedOut ? (
              // Wraps instead of being clipped by the hero (narrow phones, large text).
              <Button asChild className="h-auto min-h-9 whitespace-normal py-2 text-left">
                <Link href={loginHref}>
                  <LogIn aria-hidden="true" /> Accedi per ascoltare e salvare
                </Link>
              </Button>
            ) : null}
            <Button
              type="button"
              variant={signedOut ? 'outline' : 'default'}
              disabled={queue.length === 0}
              aria-disabled={sessionPending || undefined}
              className={WAITING_BUTTON}
              onClick={() => play(() => playCollectionQueue(player, queue))}
            >
              <Play aria-hidden="true" /> Riproduci tutto
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={queue.length === 0}
              aria-disabled={sessionPending || undefined}
              className={WAITING_BUTTON}
              onClick={() => play(() => playCollectionQueue(player, queue, true))}
            >
              <Shuffle aria-hidden="true" /> Casuale
            </Button>
            {signedIn ? (
              saved ? (
                <Button asChild variant="secondary">
                  <Link href="/library" ref={savedLinkRef}>
                    <Check aria-hidden="true" /> Salvata: apri la Libreria
                  </Link>
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  aria-disabled={saving || undefined}
                  className={WAITING_BUTTON}
                  onClick={() => void save()}
                >
                  <Plus aria-hidden="true" /> Salva nella mia libreria
                </Button>
              )
            ) : null}
            <ShareButton
              title={playlist.name}
              text={`Ascolta “${isolateName(playlist.name)}” su Solco.`}
              path={sharedPlaylistPath(shareId)}
            />
          </div>
          {signedOut && authPromptRequest > 0 ? (
            <section
              ref={authPromptRef}
              tabIndex={-1}
              className={styles.authPrompt}
              aria-labelledby="shared-playlist-auth-title"
            >
              <p id="shared-playlist-auth-title">
                <strong>Per ascoltare serve un account gratuito.</strong>
              </p>
              <p>Accedi o registrati: dopo torni qui, a questa playlist.</p>
              <div className={styles.authPromptActions}>
                <Button asChild size="sm">
                  <Link href={signupHref}>Registrati gratis</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href={loginHref}>Accedi</Link>
                </Button>
              </div>
            </section>
          ) : null}
        </div>
      </header>

      <section className={styles.listSection} aria-labelledby="shared-playlist-tracks">
        <div className={styles.listHeading}>
          <h2 id="shared-playlist-tracks">Brani</h2>
          <p>{songCount(playlist.itemCount)}</p>
        </div>
        {playlist.items.length === 0 ? (
          <p className={styles.footnote}>Questa playlist è ancora vuota.</p>
        ) : (
          // Safari/VoiceOver drop the list semantics of a list with list-style: none.
          // biome-ignore lint/a11y/noRedundantRoles: explicit role keeps the list announced.
          // biome-ignore lint/a11y/useSemanticElements: it is an <ol>; the role is the Safari fix.
          <ol className={styles.tracks} role="list">
            {playlist.items.map((item, index) => {
              const track = collectionItemToTrack(item);
              const current = isCollectionItemCurrent(player, item);
              // Loading keeps the button focusable (aria-disabled): disabled would drop the focus.
              const busy = current && player.status === 'loading';
              const title = itemTitle(item);
              const playLabel = busy
                ? `Caricamento: ${title}`
                : current
                  ? player.status === 'playing'
                    ? `Pausa: ${title}`
                    : `Riprendi: ${title}`
                  : `Riproduci ${title}`;
              return (
                <li
                  key={collectionItemQualifiedId(item)}
                  className={styles.row}
                  data-current={current ? 'true' : undefined}
                >
                  <span className={styles.index} aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className={styles.cover}>
                    <FallbackArt src={item.artworkUrl} label={title} size={52} />
                  </span>
                  <div className={styles.copy}>
                    <strong title={title}>{title}</strong>
                    {item.creatorName ? (
                      <span className={styles.artist} title={item.creatorName}>
                        {item.source === 'audius' && item.artistUrl ? (
                          <a href={item.artistUrl} target="_blank" rel="noreferrer">
                            {item.creatorName}
                            <span className="sr-only">{NEW_TAB_HINT}</span>
                          </a>
                        ) : (
                          item.creatorName
                        )}
                      </span>
                    ) : null}
                    <div className={styles.meta}>
                      <span className={styles.badge} data-source={item.source}>
                        {sourceBadge(item)}
                      </span>
                      {duration(item.durationSeconds) ? (
                        <span>{duration(item.durationSeconds)}</span>
                      ) : null}
                      {item.source === 'youtube' && item.sourceUrl ? (
                        <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                          Video su YouTube
                          <span className="sr-only">{NEW_TAB_HINT}</span>
                        </a>
                      ) : null}
                      {item.source === 'song' ? <span>cercato su YouTube all’ascolto</span> : null}
                    </div>
                    {item.source === 'audius' &&
                    item.title &&
                    item.creatorName &&
                    item.sourceUrl ? (
                      // OML §1.5: copyright ("© <artist>"), Open Music License and the track link.
                      // Only OML tracks can be saved; the stream re-checks the licence on every play.
                      <AudiusLicenseNotice
                        track={{
                          license: null,
                          copyrightNotice: null,
                          licensorName: item.creatorName,
                          attributionRemovalRequested: false,
                          title: item.title,
                          trackUrl: item.sourceUrl,
                        }}
                        showTrackLink
                      />
                    ) : null}
                    {track ? null : (
                      <span className={styles.unavailable}>{unavailableReason(item)}</span>
                    )}
                  </div>
                  {track ? (
                    <button
                      type="button"
                      className={styles.playButton}
                      aria-label={playLabel}
                      title={playLabel}
                      aria-disabled={busy || sessionPending || undefined}
                      onClick={() => {
                        if (!busy) play(() => playCollectionItem(player, item, queue));
                      }}
                    >
                      {current && player.status === 'playing' ? (
                        <Pause aria-hidden="true" />
                      ) : (
                        <Play aria-hidden="true" />
                      )}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        <p className={styles.footnote}>
          Aggiornata {updatedOn(playlist.updatedAt)}. I brani Audius si ascoltano su Solco, i video
          YouTube nel player ufficiale visibile.
        </p>
      </section>
    </main>
  );
}
