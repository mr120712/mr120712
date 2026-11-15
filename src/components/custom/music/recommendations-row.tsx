// @polsia:user-owned — riga «Potrebbe piacerti» della Home (solo con l'accesso): brani consigliati
// dal server a partire dai TUOI ascolti, Preferiti, playlist e diario, visibili solo a te.
// Brani Audius riproducibili (con la nota di licenza OML) e brani "song" proposti dall'AI, cercati su
// YouTube solo quando tocca a loro nel player. Azioni: Riproduci (o tutti in coda), «Aggiungi alla
// Libreria» (Preferiti, solo Audius), «Non mi interessa» (subito tolto, con «Annulla») e «Altri
// consigli». Con i consigli personalizzati spenti in Impostazioni mostra «Popolari su Solco».
// Tastiera: il focus non torna mai all'inizio della pagina (dopo «Non mi interessa» passa al brano
// vicino, i pulsanti col focus non vengono mai disattivati, «Riprova» lo porta al titolo).
'use client';

import { EyeOff, Heart, ListMusic, Pause, Play, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import { audiusToTrack } from '@/components/custom/music/audius-section';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useLibrary } from '@/components/custom/music/library-context';
import {
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/business/api-error-message';
import {
  RecommendationFeedbackResponseSchema,
  type RecommendationItem,
  type RecommendationMode,
  type RecommendationsResponse,
  RecommendationsResponseSchema,
  type RecommendedAudiusTrack,
} from '@/lib/contracts/recommendations';
import { usePersonalRecommendations } from '@/lib/music/recommendations-pref';
import discover from './discover.module.css';
import styles from './recommendations-row.module.css';

const SKELETON_TILES = 6;

/** Richieste in corso per URL: due montaggi della stessa riga non chiedono due volte. */
const inflight = new Map<string, Promise<RecommendationsResponse>>();

function fetchRecommendations(page: number, personal: boolean) {
  const url = `/api/music/recommendations?page=${page}${personal ? '' : '&personal=0'}`;
  let request = inflight.get(url);
  if (!request) {
    request = apiFetch(url, { schema: RecommendationsResponseSchema, cache: 'no-store' }).finally(
      () => inflight.delete(url),
    );
    inflight.set(url, request);
  }
  return request;
}

function sendFeedback(kind: 'hide' | 'unhide', item: RecommendationItem) {
  return apiFetch('/api/music/recommendations/feedback', {
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify({ kind, itemKey: item.qualifiedId }),
    schema: RecommendationFeedbackResponseSchema,
  });
}

/** Il brano per il player: Audius in streaming da Solco, "song" cercato su YouTube al suo turno. */
function recommendationToTrack(item: RecommendationItem): MusicPlayerTrack {
  if (item.kind === 'audius') return audiusToTrack(item);
  return {
    qualifiedId: item.qualifiedId,
    title: item.title,
    artistName: item.artistName,
    artworkUrl: null,
    sourceLabel: 'YouTube',
    sourceUrl: null,
    playbackMode: 'song',
  };
}

const HEADINGS: Record<RecommendationMode, { eyebrow: string; title: string }> = {
  personal: { eyebrow: 'PER TE', title: 'Potrebbe piacerti' },
  starter: { eyebrow: 'PER TE', title: 'Per iniziare' },
  popular: { eyebrow: 'SU SOLCO', title: 'Popolari su Solco' },
};

type Ready = RecommendationsResponse & { status: 'ready'; served: number };
type State = { status: 'loading' } | { status: 'error' } | Ready;
/** Dove portare il focus dopo il prossimo render (il pulsante premuto non esiste più). */
type FocusTarget = { hideKey: string } | 'more' | 'heading';

export function RecommendationsRow() {
  const library = useLibrary();
  const personal = usePersonalRecommendations();
  // Il player si usa solo dentro la riga: senza accesso (o fuori dai provider) non si monta nulla.
  if (!library.signedIn) return null;
  return <RecommendationsRail key={personal ? 'personal' : 'popular'} personal={personal} />;
}

function RecommendationsRail({ personal }: { personal: boolean }) {
  const player = useMusicPlayer();
  const headingId = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
  const requestId = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const hideButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<FocusTarget | null>(null);

  // Dopo ogni render: se un'azione ha tolto il pulsante col focus, il focus va dove indicato.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const element =
      target === 'heading'
        ? headingRef.current
        : target === 'more'
          ? moreRef.current
          : hideButtons.current.get(target.hideKey);
    (element ?? headingRef.current)?.focus();
  });

  const loadFirst = useCallback(() => {
    const id = ++requestId.current;
    setState({ status: 'loading' });
    fetchRecommendations(0, personal).then(
      (data) => {
        if (id === requestId.current)
          setState({ ...data, status: 'ready', served: data.items.length });
      },
      () => {
        if (id === requestId.current) setState({ status: 'error' });
      },
    );
  }, [personal]);

  useEffect(() => {
    loadFirst();
    return () => {
      // Smontata: le risposte in arrivo non toccano più lo stato.
      requestId.current += 1;
    };
  }, [loadFirst]);

  if (state.status === 'ready' && state.served === 0) return null;

  // Il modo «popolari» è noto già mentre carica: titolo e sottotitolo non cambiano all'arrivo.
  const mode: RecommendationMode =
    state.status === 'ready' ? state.mode : personal ? 'personal' : 'popular';
  const heading = HEADINGS[mode];
  const items = state.status === 'ready' ? state.items : [];
  const moreDisabled = state.status !== 'ready' || state.nextPage === null || loadingMore;
  const queue = items.map(recommendationToTrack);
  const isCurrent = (item: RecommendationItem) =>
    player.currentTrack?.qualifiedId === item.qualifiedId ||
    player.currentTrack?.importedFrom === item.qualifiedId;

  const play = (item: RecommendationItem) => {
    if (isCurrent(item)) {
      void player.togglePlayback();
      return;
    }
    const track = recommendationToTrack(item);
    const path = trackStreamPath(track);
    if (path) void player.playTrack(track, path, queue);
  };

  const retry = () => {
    // «Riprova» sparisce con lo scheletro: il focus va al titolo della riga.
    headingRef.current?.focus();
    loadFirst();
  };

  const playAll = () => {
    const first = queue[0];
    const path = first ? trackStreamPath(first) : null;
    if (first && path) void player.playTrack(first, path, queue);
  };

  const more = async () => {
    if (state.status !== 'ready' || state.nextPage === null || loadingMore) return;
    const id = ++requestId.current;
    setLoadingMore(true);
    try {
      const data = await fetchRecommendations(state.nextPage, personal);
      if (id === requestId.current)
        setState({ ...data, status: 'ready', served: data.items.length });
    } catch (error) {
      if (id === requestId.current) {
        toast.error(apiErrorMessage(error, 'Non riesco a caricare altri consigli. Riprova.'));
      }
    } finally {
      if (id === requestId.current) setLoadingMore(false);
    }
  };

  /** Rimette un brano nascosto al suo posto, se la pagina è ancora la stessa. */
  const restore = (item: RecommendationItem, index: number, page: number) => {
    setState((current) => {
      if (current.status !== 'ready' || current.page !== page) return current;
      if (current.items.some((entry) => entry.qualifiedId === item.qualifiedId)) return current;
      const next = [...current.items];
      next.splice(Math.min(index, next.length), 0, item);
      return { ...current, items: next };
    });
  };

  const undo = async (item: RecommendationItem, index: number, page: number) => {
    try {
      await sendFeedback('unhide', item);
      restore(item, index, page);
      toast.success('Il brano torna tra i consigli.');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Non è stato possibile annullare. Riprova.'));
    }
  };

  const hide = async (item: RecommendationItem) => {
    if (state.status !== 'ready') return;
    const index = state.items.findIndex((entry) => entry.qualifiedId === item.qualifiedId);
    const page = state.page;
    // Il focus passa al «Non mi interessa» del brano dopo (o prima); a pagina vuota, ad «Altri
    // consigli» o al titolo.
    const neighbour = state.items[index + 1] ?? state.items[index - 1];
    pendingFocus.current = neighbour
      ? { hideKey: neighbour.qualifiedId }
      : state.nextPage !== null
        ? 'more'
        : 'heading';
    // Subito via dalla riga; se il server non lo salva, torna al suo posto.
    setState((current) =>
      current.status === 'ready'
        ? {
            ...current,
            items: current.items.filter((entry) => entry.qualifiedId !== item.qualifiedId),
          }
        : current,
    );
    try {
      await sendFeedback('hide', item);
      toast('Non vedrai più questo brano nei consigli.', {
        action: { label: 'Annulla', onClick: () => void undo(item, index, page) },
      });
    } catch (error) {
      restore(item, index, page);
      toast.error(apiErrorMessage(error, 'Non è stato possibile nasconderlo. Riprova.'));
    }
  };

  const favorite = async (item: RecommendedAudiusTrack) => {
    if (saved.has(item.qualifiedId)) return;
    try {
      await apiFetch('/api/music/collections', {
        method: 'POST',
        body: JSON.stringify({ action: 'favorite', source: 'audius', sourceId: item.id }),
      });
      setSaved((current) => new Set(current).add(item.qualifiedId));
      toast.success('Aggiunto ai Preferiti della Libreria.');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Non è stato possibile aggiungerlo alla Libreria.'));
    }
  };

  const hasAudius = items.some((item) => item.kind === 'audius');

  return (
    <section
      className={`${discover.section} ${discover.contained}`}
      id="per-te"
      aria-labelledby={headingId}
      aria-busy={state.status === 'loading' || loadingMore}
    >
      <header className={`${discover.sectionHeader} ${styles.header}`}>
        <div>
          <p className={discover.eyebrow}>{heading.eyebrow}</p>
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.heading}>
            {heading.title}
          </h2>
          {mode === 'starter' ? (
            <p className={styles.subtitle}>
              Brani amati dalla community e di tendenza: ascoltane qualcuno e i consigli diventano
              tuoi.
            </p>
          ) : null}
          {mode === 'popular' ? (
            <p className={styles.subtitle}>
              Consigli personalizzati spenti in <Link href="/impostazioni">Impostazioni</Link>.
            </p>
          ) : null}
        </div>
        {/* Sempre presenti (inattivi finché non ci sono brani): l'intestazione non cambia altezza.
            aria-disabled e non disabled: un pulsante col focus non lo perde. */}
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.action} ${styles.primary}`}
            onClick={playAll}
            aria-disabled={queue.length === 0}
          >
            <ListMusic aria-hidden="true" />
            Riproduci tutti
          </button>
          <button
            ref={moreRef}
            type="button"
            className={styles.action}
            onClick={() => void more()}
            aria-disabled={moreDisabled}
          >
            <RefreshCw aria-hidden="true" />
            {loadingMore ? 'Caricamento…' : 'Altri consigli'}
          </button>
        </div>
      </header>

      <div className={styles.body}>
        {state.status === 'loading' ? (
          <>
            <output className="sr-only">Caricamento dei consigli…</output>
            <ul className={styles.rail} aria-hidden="true">
              {Array.from({ length: SKELETON_TILES }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: segnaposto fissi e identici.
                <li key={index} className={`${discover.tile} ${styles.card}`}>
                  <span className={styles.skeletonArt} />
                  <span className={styles.skeletonLine} />
                  <span className={styles.skeletonLine} />
                  <span className={styles.skeletonLine} />
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {state.status === 'error' ? (
          <div className={styles.empty} role="alert">
            <p>Non riesco a caricare i consigli in questo momento.</p>
            <button type="button" className={styles.action} onClick={retry}>
              <RefreshCw aria-hidden="true" />
              Riprova
            </button>
          </div>
        ) : null}

        {state.status === 'ready' && items.length === 0 ? (
          <div className={styles.empty}>
            <p>Hai nascosto tutti i brani di questa pagina.</p>
          </div>
        ) : null}

        {items.length > 0 ? (
          <ol className={styles.rail}>
            {items.map((item) => {
              const playing = isCurrent(item) && player.status === 'playing';
              const inLibrary = saved.has(item.qualifiedId);
              return (
                <li key={item.qualifiedId} className={`${discover.tile} ${styles.card}`}>
                  <div className={discover.tileArt}>
                    <FallbackArt
                      src={item.kind === 'audius' ? item.artworkUrl : null}
                      label={item.title}
                      size={240}
                    />
                    <button
                      type="button"
                      className={discover.tilePlay}
                      onClick={() => play(item)}
                      aria-label={
                        playing ? `Metti in pausa ${item.title}` : `Riproduci ${item.title}`
                      }
                    >
                      {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                    </button>
                  </div>
                  <strong className={discover.tileTitle} title={item.title}>
                    {item.title}
                  </strong>
                  <span className={discover.tileMeta}>{item.artistName}</span>
                  <span className={styles.reason}>{item.reason.text}</span>
                  {item.kind === 'audius' ? (
                    <AudiusLicenseNotice track={item} showTrackLink />
                  ) : (
                    <span className={styles.note}>Cercato su YouTube quando lo ascolti</span>
                  )}
                  <div className={styles.cardActions}>
                    {item.kind === 'audius' ? (
                      <button
                        type="button"
                        className={discover.iconButton}
                        onClick={() => void favorite(item)}
                        aria-disabled={inLibrary}
                        aria-pressed={inLibrary}
                        aria-label={
                          inLibrary
                            ? `${item.title} è nei Preferiti`
                            : `Aggiungi alla Libreria: ${item.title}`
                        }
                      >
                        <Heart aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      ref={(element) => {
                        if (element) hideButtons.current.set(item.qualifiedId, element);
                        else hideButtons.current.delete(item.qualifiedId);
                      }}
                      type="button"
                      className={discover.iconButton}
                      onClick={() => void hide(item)}
                      aria-label={`Non mi interessa: ${item.title}`}
                    >
                      <EyeOff aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>

      {/* Per gli account Free l'avviso c'è già mentre carica: non sposta la pagina all'arrivo. */}
      {player.premium === false && (state.status === 'loading' || hasAudius) ? (
        <p className={styles.footnote}>
          Account Free: ogni brano Audius conta nei 40 ascolti completi del mese, anche quelli che
          partono da soli con «Riproduci tutti».
        </p>
      ) : null}
    </section>
  );
}
