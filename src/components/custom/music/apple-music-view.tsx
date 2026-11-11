// @polsia:user-owned — Apple Music dentro Solco (MusicKit JS). Chi è abbonato ad Apple Music
// ascolta i brani completi: le licenze sono quelle del suo abbonamento. Senza abbonamento Apple
// fornisce solo anteprime. Non conta nei 40 ascolti Free di Solco. Non promettere l'ascolto a
// schermo bloccato o in background finché non è verificato su telefoni reali (iOS e Android).
'use client';

import { Loader2, Pause, Play, Search, SkipForward } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { Button } from '@/components/ui/button';
import styles from './discover.module.css';

const MUSICKIT_SRC = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';

type Artwork = { url: string };
type Song = {
  id: string;
  attributes: { name: string; artistName: string; albumName?: string; artwork?: Artwork };
};
type MusicKitInstance = {
  isAuthorized: boolean;
  isPlaying: boolean;
  storefrontId: string;
  nowPlayingItem?: { id: string; title?: string; artistName?: string } | null;
  authorize: () => Promise<string>;
  unauthorize: () => Promise<void>;
  setQueue: (options: {
    songs: string[];
    startWith?: number;
    startPlaying?: boolean;
  }) => Promise<unknown>;
  play: () => Promise<void>;
  pause: () => void;
  skipToNextItem: () => Promise<void>;
  addEventListener: (name: string, callback: () => void) => void;
  removeEventListener: (name: string, callback: () => void) => void;
  api: {
    music: (
      path: string,
      query?: Record<string, string | number>,
    ) => Promise<{ data: { results?: { songs?: { data: Song[] } } } }>;
  };
};
type MusicKitGlobal = {
  configure: (options: {
    developerToken: string;
    app: { name: string; build: string };
  }) => Promise<MusicKitInstance>;
  getInstance: () => MusicKitInstance;
};

declare global {
  interface Window {
    MusicKit?: MusicKitGlobal;
  }
}

let loader: Promise<MusicKitInstance> | null = null;

/** Loads MusicKit once per page load, configured with Solco's developer token. */
function loadMusicKit() {
  loader ??= (async () => {
    const response = await fetch('/api/music/apple/token', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('not_configured');
    const { token } = (await response.json()) as { token: string };
    if (!window.MusicKit) {
      await new Promise<void>((resolve, reject) => {
        document.addEventListener('musickitloaded', () => resolve(), { once: true });
        const script = document.createElement('script');
        script.src = MUSICKIT_SRC;
        script.async = true;
        script.onerror = () => reject(new Error('script_failed'));
        document.head.appendChild(script);
      });
    }
    const MusicKit = window.MusicKit;
    if (!MusicKit) throw new Error('script_failed');
    return MusicKit.configure({ developerToken: token, app: { name: 'Solco', build: '1.0' } });
  })();
  loader.catch(() => {
    loader = null;
  });
  return loader;
}

function artworkUrl(song: Song, size = 160) {
  return (
    song.attributes.artwork?.url.replace('{w}', String(size)).replace('{h}', String(size)) ?? null
  );
}

export function AppleMusicView() {
  const solcoPlayer = useMusicPlayer();
  const [state, setState] = useState<'loading' | 'unavailable' | 'ready'>('loading');
  const [authorized, setAuthorized] = useState(false);
  const [query, setQuery] = useState('');
  const [songs, setSongs] = useState<Song[]>([]);
  const [searching, setSearching] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const musicRef = useRef<MusicKitInstance | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadMusicKit()
      .then((music) => {
        if (cancelled) return;
        musicRef.current = music;
        setAuthorized(music.isAuthorized);
        setState('ready');
      })
      .catch(() => !cancelled && setState('unavailable'));
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribes once MusicKit is ready: `state` flips to 'ready' after musicRef is set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when MusicKit becomes ready.
  useEffect(() => {
    const music = musicRef.current;
    if (!music) return;
    const update = () => {
      setIsPlaying(music.isPlaying);
      setPlayingId(music.nowPlayingItem?.id ?? null);
    };
    const auth = () => setAuthorized(music.isAuthorized);
    music.addEventListener('playbackStateDidChange', update);
    music.addEventListener('nowPlayingItemDidChange', update);
    music.addEventListener('authorizationStatusDidChange', auth);
    return () => {
      music.removeEventListener('playbackStateDidChange', update);
      music.removeEventListener('nowPlayingItemDidChange', update);
      music.removeEventListener('authorizationStatusDidChange', auth);
    };
  }, [state]);

  const connect = useCallback(async () => {
    try {
      await musicRef.current?.authorize();
      setAuthorized(Boolean(musicRef.current?.isAuthorized));
      toast.success('Apple Music collegato.');
    } catch {
      toast.error('Collegamento con Apple Music non riuscito. Riprova.');
    }
  }, []);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const music = musicRef.current;
    const term = query.trim();
    if (!music || !term) return;
    setSearching(true);
    try {
      const result = await music.api.music(`/v1/catalog/${music.storefrontId || 'it'}/search`, {
        term,
        types: 'songs',
        limit: 25,
      });
      setSongs(result.data.results?.songs?.data ?? []);
    } catch {
      toast.error('Ricerca su Apple Music non riuscita.');
    } finally {
      setSearching(false);
    }
  };

  const play = async (index: number) => {
    const music = musicRef.current;
    const song = songs[index];
    if (!music || !song) return;
    if (playingId === song.id) {
      if (music.isPlaying) music.pause();
      else await music.play();
      return;
    }
    // One player at a time: pause Solco's own player first.
    if (solcoPlayer.status === 'playing') await solcoPlayer.togglePlayback();
    try {
      await music.setQueue({
        songs: songs.map((item) => item.id),
        startWith: index,
        startPlaying: true,
      });
    } catch {
      toast.error('Questo brano non si può riprodurre adesso.');
    }
  };

  if (state === 'loading') {
    return <p className={styles.state}>Caricamento di Apple Music…</p>;
  }
  if (state === 'unavailable') {
    return (
      <p className={styles.state}>Apple Music non è ancora disponibile su Solco. Torna presto!</p>
    );
  }

  return (
    <div className={styles.page}>
      <section className={styles.section} aria-labelledby="apple-connect">
        <header className={styles.sectionHeader}>
          <div>
            <p className={styles.eyebrow}>APPLE MUSIC</p>
            <h2 id="apple-connect">
              {authorized ? 'Apple Music è collegato' : 'Collega il tuo Apple Music'}
            </h2>
          </div>
        </header>
        <p className={styles.state}>
          {authorized
            ? 'Ascolti i brani completi con il tuo abbonamento Apple Music. Non contano nei 40 ascolti Free di Solco.'
            : 'Con un abbonamento Apple Music ascolti l’intero catalogo nel player di Solco, senza consumare i 40 ascolti Free. Senza abbonamento Apple offre anteprime.'}
        </p>
        <div className={styles.headerActions}>
          {authorized ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void musicRef.current?.unauthorize().then(() => setAuthorized(false))}
            >
              Scollega
            </Button>
          ) : (
            <Button type="button" onClick={() => void connect()}>
              Collega Apple Music
            </Button>
          )}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="apple-search">
        <header className={styles.sectionHeader}>
          <h2 id="apple-search">Cerca su Apple Music</h2>
        </header>
        <form onSubmit={search} className={styles.headerActions}>
          <label className="sr-only" htmlFor="apple-query">
            Cerca brani su Apple Music
          </label>
          <input
            id="apple-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Artista o brano"
            maxLength={100}
            className="min-h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm"
          />
          <Button type="submit" disabled={searching || !query.trim()}>
            {searching ? <Loader2 aria-hidden="true" /> : <Search aria-hidden="true" />} Cerca
          </Button>
        </form>
        {songs.length ? (
          <ol className={styles.list}>
            {songs.map((song, index) => {
              const current = playingId === song.id;
              return (
                <li key={song.id} className={styles.row}>
                  <div className={styles.rowArt}>
                    <FallbackArt src={artworkUrl(song)} label={song.attributes.name} size={104} />
                  </div>
                  <div className={styles.rowCopy}>
                    <strong title={song.attributes.name}>{song.attributes.name}</strong>
                    <span>
                      {[song.attributes.artistName, song.attributes.albumName]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={`${styles.iconButton} ${styles.playButton}`}
                      onClick={() => void play(index)}
                      aria-label={
                        current && isPlaying
                          ? `Metti in pausa ${song.attributes.name}`
                          : `Riproduci ${song.attributes.name}`
                      }
                    >
                      {current && isPlaying ? (
                        <Pause aria-hidden="true" />
                      ) : (
                        <Play aria-hidden="true" />
                      )}
                    </button>
                    {current ? (
                      <button
                        type="button"
                        className={styles.iconButton}
                        onClick={() => void musicRef.current?.skipToNextItem()}
                        aria-label="Brano successivo"
                      >
                        <SkipForward aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
      </section>
    </div>
  );
}
