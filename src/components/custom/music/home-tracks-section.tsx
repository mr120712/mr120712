// @polsia:user-owned — "In evidenza" in Home: i file audio messi dall'amministratore direttamente
// nello store Vercel Blob (dal pannello), divisi in sezioni (una per cartella) e mostrati con la
// loro copertina. Riproducibili con il player; la coda è la sezione toccata. Si nasconde del tutto
// se non ce ne sono (nessun ingombro in Home).
'use client';

import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { homeTrackToTrack } from '@/components/custom/music/live-tracks';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import {
  HOME_TRACKS_DEFAULT_SECTION,
  type HomeTrack,
  type HomeTrackSection,
  HomeTracksResponseSchema,
} from '@/lib/contracts/home-tracks';
import styles from './home-tracks-section.module.css';

/** Intervallo minimo tra due aggiornamenti automatici (anti-martellamento). */
const REFRESH_THROTTLE_MS = 15_000;
/** Backstop: ricontrolla lo store Blob ogni tanto mentre la scheda è aperta e visibile. */
const BACKGROUND_REFRESH_MS = 60_000;

/** Sezioni dalla risposta; un server meno recente manda solo `items`: una sezione unica. */
function sectionsFrom(response: {
  items: HomeTrack[];
  sections?: HomeTrackSection[];
}): HomeTrackSection[] {
  const withItems = (response.sections ?? []).filter((section) => section.items.length > 0);
  if (withItems.length > 0) return withItems;
  return response.items.length > 0
    ? [{ id: '', title: HOME_TRACKS_DEFAULT_SECTION, items: response.items }]
    : [];
}

export function HomeTracksSection() {
  const player = useMusicPlayer();
  const [sections, setSections] = useState<HomeTrackSection[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const lastLoadRef = useRef(0);

  // `fresh` aggira la cache CDN (query-string): serve a vedere SUBITO un file appena caricato nel
  // pannello Vercel Blob. Il primo caricamento usa invece l'endpoint in cache (economico). Non
  // mette mai in stato 'loading': un aggiornamento in background non deve nascondere la sezione.
  const load = useCallback(async (fresh = false) => {
    // Segna il momento SUBITO (prima dell'await): così due eventi ravvicinati (focus +
    // visibilitychange al ritorno sulla scheda) non fanno partire due richieste identiche — la
    // seconda cade dentro la finestra di throttle.
    lastLoadRef.current = Date.now();
    try {
      const url = fresh ? `/api/music/home-tracks?t=${Date.now()}` : '/api/music/home-tracks';
      const response = await apiFetch(url, { schema: HomeTracksResponseSchema });
      setSections(sectionsFrom(response as { items: HomeTrack[]; sections?: HomeTrackSection[] }));
      setState('ready');
    } catch {
      setState((current) => (current === 'loading' ? 'error' : current));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-aggiornamento: ogni volta che carichi un file nel pannello Vercel (altra scheda) e torni su
  // Solco, l'elenco si aggiorna da solo interrogando di nuovo lo store Blob. Trigger: ritorno di
  // focus / scheda di nuovo visibile, più un controllo periodico di riserva mentre resti sulla
  // pagina. Il throttle evita richieste ravvicinate; l'API resta protetta dal suo rate-limit.
  useEffect(() => {
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (Date.now() - lastLoadRef.current < REFRESH_THROTTLE_MS) return;
      void load(true);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(refresh, BACKGROUND_REFRESH_MS);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
    };
  }, [load]);

  const play = (item: HomeTrack, section: HomeTrackSection) => {
    const track = homeTrackToTrack(item);
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    // La coda è la sezione: si ascolta la cartella, dal brano toccato in poi.
    const queue = section.items.map(homeTrackToTrack);
    void player.playTrack(track, track.streamUrl ?? '', queue);
  };

  // Si nasconde finché carica, in errore o se vuota: nessun ingombro in Home.
  if (state !== 'ready' || sections.length === 0) return null;

  return (
    <>
      {sections.map((section, index) => {
        const headingId = index === 0 ? 'in-evidenza-heading' : `in-evidenza-heading-${index}`;
        // La radice dello store (id ''), non un titolo: una cartella chiamata "In evidenza" resta sé.
        const isDefault = section.id === '';
        return (
          <section
            key={section.id || '__root'}
            id={index === 0 ? 'in-evidenza' : undefined}
            className={styles.section}
            aria-labelledby={headingId}
          >
            <div className={styles.head}>
              <p className={styles.eyebrow}>{isDefault ? 'IN EVIDENZA' : 'IN EVIDENZA · SOLCO'}</p>
              <h2 id={headingId} className={styles.title}>
                {isDefault ? 'Ascolta ora' : section.title}
              </h2>
            </div>
            <ul className={styles.rail}>
              {section.items.map((item) => {
                const qualifiedId = `upload:${item.id}`;
                const isCurrent = player.currentTrack?.qualifiedId === qualifiedId;
                const playing = isCurrent && player.status === 'playing';
                const byline = item.artist ?? 'Solco';
                return (
                  <li key={item.id} className={styles.card} data-current={isCurrent || undefined}>
                    <button
                      type="button"
                      className={styles.cardButton}
                      onClick={() => play(item, section)}
                      aria-label={
                        playing
                          ? `Metti in pausa ${item.title} di ${byline}`
                          : `Riproduci ${item.title} di ${byline}`
                      }
                      aria-pressed={isCurrent ? playing : undefined}
                    >
                      <span className={styles.art}>
                        <FallbackArt src={item.artworkUrl} label={item.title} size={160} />
                        <span className={styles.playBadge} aria-hidden="true">
                          {playing ? <Pause /> : <Play />}
                        </span>
                      </span>
                      <strong className={styles.cardTitle} title={item.title}>
                        {item.title}
                      </strong>
                      <span className={styles.meta}>{byline}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </>
  );
}
