// @polsia:user-owned — "Ascolta in Solco": incolli quello che hai copiato da Spotify o da un'altra
// app (o scrivi "Artista - Titolo") e Solco trova il brano e lo avvia nel suo player.
'use client';

import { Music4 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import {
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import { Button } from '@/components/ui/button';
import { isLinkOnly, parseSharedSong } from '@/lib/business/shared-song';
import { songIdentity } from '@/lib/business/track-list-import';
import styles from './discover.module.css';

/** Same id scheme as imported songs: sha-256 of the normalised artist + title, 32 hex chars. */
async function songId(title: string, artist: string | null) {
  const bytes = new TextEncoder().encode(songIdentity(title, artist));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export function ListenInSolco() {
  const player = useMusicPlayer();
  const inputId = useId();
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (isLinkOnly(text)) {
      setMessage(
        'Il link da solo non contiene il titolo. In Spotify usa Condividi → Copia link e incolla tutto il testo, oppure scrivi “Artista - Titolo”.',
      );
      return;
    }
    const song = parseSharedSong(text);
    if (!song) {
      setMessage('Scrivi “Artista - Titolo” oppure incolla il testo condiviso da un’altra app.');
      return;
    }
    const track: MusicPlayerTrack = {
      qualifiedId: `song:${await songId(song.title, song.artist)}`,
      title: song.title,
      artistName: song.artist ?? '',
      artworkUrl: null,
      sourceLabel: 'YouTube',
      sourceUrl: null,
      playbackMode: 'song',
    };
    const path = trackStreamPath(track);
    if (path) await player.playTrack(track, path, [track]);
    setText('');
  };

  return (
    <details className={styles.importPanel}>
      <summary>
        <Music4 aria-hidden="true" /> Ascolta in Solco un brano da Spotify o da un’altra app
      </summary>
      <form className={styles.aiForm} onSubmit={(event) => void submit(event)}>
        <label htmlFor={inputId} className={styles.state}>
          In Spotify tocca Condividi → Copia link e incolla qui il testo, oppure scrivi “Artista -
          Titolo”. Solco cerca il brano e lo avvia nel suo player.
        </label>
        <input
          id={inputId}
          value={text}
          maxLength={500}
          placeholder="Artista - Titolo"
          onChange={(event) => setText(event.target.value)}
          className="min-h-10 rounded-lg border border-input bg-background px-3 text-sm"
        />
        <div className={styles.headerActions}>
          <Button type="submit" disabled={!text.trim() || player.status === 'loading'}>
            Ascolta in Solco
          </Button>
        </div>
        {message ? (
          <p className={styles.state} role="alert">
            {message}
          </p>
        ) : null}
      </form>
    </details>
  );
}
