// @polsia:user-owned — video TikTok scelti da Solco, nel player ufficiale TikTok (Embed Player v1).
// Il player si carica solo quando l'utente lo chiede (cookie e dati di terze parti), resta sempre
// visibile e non suona mai insieme al player di Solco né in background.
'use client';

import { ExternalLink, Music2, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { type TikTokClip, TikTokClipListSchema } from '@/lib/contracts/library';
import { TIKTOK_ORIGIN, tiktokPlayerUrl } from '@/lib/music/tiktok';
import styles from './discover.module.css';

type PlayerMessage = { 'x-tiktok-player'?: boolean; type?: string; value?: unknown };

function readMessage(data: unknown): PlayerMessage | null {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? (value as PlayerMessage) : null;
}

/** Sends a command to one TikTok player, only to TikTok's origin. */
function postToPlayer(frame: HTMLIFrameElement | null, type: 'pause' | 'play') {
  frame?.contentWindow?.postMessage({ 'x-tiktok-player': true, type }, TIKTOK_ORIGIN);
}

function TikTokPlayer({ clip }: { clip: TikTokClip }) {
  const player = useMusicPlayer();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const readyRef = useRef(false);
  const pauseSolcoRef = useRef(player.togglePlayback);
  const solcoPlayingRef = useRef(false);
  pauseSolcoRef.current = player.togglePlayback;
  solcoPlayingRef.current = player.status === 'playing';

  // Messages from this player only: pause Solco when TikTok plays; show a link on errors.
  useEffect(() => {
    if (!loaded) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== TIKTOK_ORIGIN || event.source !== frameRef.current?.contentWindow)
        return;
      const message = readMessage(event.data);
      if (!message?.['x-tiktok-player']) return;
      if (message.type === 'onPlayerReady') readyRef.current = true;
      if (message.type === 'onStateChange' && message.value === 1 && solcoPlayingRef.current) {
        void pauseSolcoRef.current();
      }
      if (message.type === 'onPlayerError' || message.type === 'onError') setFailed(true);
    };
    window.addEventListener('message', onMessage);
    const timeout = window.setTimeout(() => {
      if (!readyRef.current) setFailed(true);
    }, 12_000);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeout);
    };
  }, [loaded]);

  // Never in the background: pause when Solco plays, when hidden, or when scrolled away.
  useEffect(() => {
    if (loaded && player.status === 'playing') postToPlayer(frameRef.current, 'pause');
  }, [loaded, player.status]);
  useEffect(() => {
    if (!loaded) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') postToPlayer(frameRef.current, 'pause');
    };
    document.addEventListener('visibilitychange', onVisibility);
    const frame = frameRef.current;
    const observer =
      frame && 'IntersectionObserver' in window
        ? new IntersectionObserver(
            ([entry]) => {
              if (entry && entry.intersectionRatio < 0.25) postToPlayer(frameRef.current, 'pause');
            },
            { threshold: [0, 0.25, 1] },
          )
        : null;
    if (frame) observer?.observe(frame);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
    };
  }, [loaded]);

  return (
    <article className={styles.tiktokCard}>
      {failed ? (
        <div className={styles.tiktokPlaceholder}>
          <p>Il video non è disponibile qui.</p>
          <a href={clip.canonicalUrl} target="_blank" rel="noreferrer">
            Apri su TikTok <ExternalLink aria-hidden="true" />
          </a>
        </div>
      ) : loaded ? (
        <iframe
          ref={frameRef}
          src={tiktokPlayerUrl(clip.videoId, true)}
          title={`Video TikTok di @${clip.handle}`}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className={styles.tiktokFrame}
        />
      ) : (
        <button type="button" className={styles.tiktokPlaceholder} onClick={() => setLoaded(true)}>
          <Play aria-hidden="true" />
          <span>Carica video TikTok di @{clip.handle}</span>
          <small>
            Il video viene caricato da TikTok, che può usare cookie e dati di navigazione.
          </small>
        </button>
      )}
      <div className={styles.tiktokMeta}>
        {clip.caption ? <p>{clip.caption}</p> : null}
        <div className={styles.headerActions}>
          <a href={clip.canonicalUrl} target="_blank" rel="noreferrer">
            Apri su TikTok <ExternalLink aria-hidden="true" />
          </a>
          {clip.soundUrl ? (
            <a href={clip.soundUrl} target="_blank" rel="noreferrer">
              <Music2 aria-hidden="true" /> Apri il suono su TikTok
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** Up to 6 curated TikTok videos for a genre (or the Home); hidden when there are none. */
export function TikTokClips({ genre }: { genre?: string }) {
  const [clips, setClips] = useState<TikTokClip[]>([]);
  useEffect(() => {
    let cancelled = false;
    const path = genre
      ? `/api/music/tiktok?genre=${encodeURIComponent(genre)}`
      : '/api/music/tiktok';
    apiFetch(path, { schema: TikTokClipListSchema })
      .then((value) => !cancelled && setClips(value.clips))
      .catch(() => !cancelled && setClips([]));
    return () => {
      cancelled = true;
    };
  }, [genre]);
  if (clips.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Su TikTok">
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>SU TIKTOK</p>
          <h2>Video scelti da Solco</h2>
        </div>
      </header>
      <div className={styles.tiktokRail}>
        {clips.map((clip) => (
          <TikTokPlayer key={clip.id} clip={clip} />
        ))}
      </div>
    </section>
  );
}
