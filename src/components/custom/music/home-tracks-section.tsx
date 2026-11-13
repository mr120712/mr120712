// @polsia:user-owned — sezione "In evidenza" in Home: i file audio messi dall'amministratore
// direttamente nello store Vercel Blob (dal pannello), riproducibili con il player. Si nasconde
// del tutto se non ce ne sono (nessun ingombro in Home).
'use client';

import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { homeTrackToTrack } from '@/components/custom/music/live-tracks';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { type HomeTrack, HomeTracksResponseSchema } from '@/lib/contracts/home-tracks';
import styles from './home-tracks-section.module.css';

/** Intervallo minimo tra due aggiornamenti automatici (anti-martellamento). */
const REFRESH_THROTTLE_MS = 15_000;
/** Backstop: ricontrolla lo store Blob ogni tanto mentre la scheda è aperta e visibile. */
const BACKGROUND_REFRESH_MS = 60_000;

export function HomeTracksSection() {
  const player = useMusicPlayer();
  const [items, setItems] = useState<HomeTrack[]>([]);
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
      const { items: list } = await apiFetch(url, { schema: HomeTracksResponseSchema });
      setItems(list);
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

  const play = (item: HomeTrack) => {
    const track = homeTrackToTrack(item);
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const queue = items.map(homeTrackToTrack);
    void player.playTrack(track, track.streamUrl ?? '', queue);
  };

  // Si nasconde finché carica, in errore o se vuota: nessun ingombro in Home.
  if (state !== 'ready' || items.length === 0) return null;

  return (
    <section id="in-evidenza" className={styles.section} aria-labelledby="in-evidenza-heading">
      <div className={styles.head}>
        <p className={styles.eyebrow}>IN EVIDENZA</p>
        <h2 id="in-evidenza-heading" className={styles.title}>
          Ascolta ora
        </h2>
      </div>
      <ul className={styles.list}>
        {items.map((item) => {
          const qualifiedId = `upload:${item.id}`;
          const playing =
            player.currentTrack?.qualifiedId === qualifiedId && player.status === 'playing';
          return (
            <li key={item.id} className={styles.row}>
              <button
                type="button"
                className={styles.playButton}
                onClick={() => play(item)}
                aria-label={playing ? `Metti in pausa ${item.title}` : `Riproduci ${item.title}`}
              >
                {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              </button>
              <div className={styles.copy}>
                <strong className={styles.title2} title={item.title}>
                  {item.title}
                </strong>
                <span className={styles.meta}>{item.artist ?? 'Solco'}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
