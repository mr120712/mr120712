// @polsia:user-owned — scheda compatta "La tua musica" per la Home: ascolto rapido dei brani
// offline sul dispositivo. La gestione completa (aggiungi/rimuovi/svuota) resta in Libreria.
// Client-only, legge da IndexedDB, funziona offline e da sloggati, usa il player condiviso.
'use client';

import { Download, HardDriveDownload, Play, Shuffle } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { localTrackToPlayerTrack } from '@/components/custom/music/local-tracks';
import { useOptionalMusicPlayer } from '@/components/custom/music/music-player';
import { subscribeLocalMusicChanged } from '@/components/custom/music/offline-download';
import { Button } from '@/components/ui/button';
import { isLocalMusicSupported, type LocalTrack, listTracks } from '@/lib/local-music';
import styles from './local-music-home-card.module.css';

// Deve combaciare con l'id della sezione completa in Libreria (local-music-section.tsx): la
// scorciatoia #la-tua-musica della Home punta a questa scheda, "Vedi tutto" alla Libreria.
const SECTION_ID = 'la-tua-musica';
const LIBRARY_HREF = `/library#${SECTION_ID}`;

/** Copia mescolata (Fisher–Yates). */
function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

function countLabel(n: number): string {
  return n === 1 ? '1 brano' : `${n} brani`;
}

export function LocalMusicHomeCard() {
  const player = useOptionalMusicPlayer();
  // null = non ancora caricato (SSR e primo render client); poi la lista reale.
  const [tracks, setTracks] = useState<LocalTrack[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTracks(await listTracks());
    } catch {
      setTracks([]);
    }
  }, []);

  useEffect(() => {
    if (!isLocalMusicSupported()) {
      setTracks([]);
      return;
    }
    void refresh();
  }, [refresh]);

  // Aggiorna se un download finisce altrove sulla pagina (es. da una playlist).
  useEffect(() => subscribeLocalMusicChanged(() => void refresh()), [refresh]);

  const play = (order: readonly LocalTrack[]) => {
    const queue = order.map(localTrackToPlayerTrack);
    const first = queue[0];
    if (!player || !first) return;
    void player.playTrack(first, '', queue);
  };

  const hasTracks = tracks !== null && tracks.length > 0;
  const sub =
    tracks === null
      ? 'Ascolta i tuoi file anche senza rete.'
      : hasTracks
        ? `${countLabel(tracks.length)} sul dispositivo · si ascoltano anche offline`
        : 'Aggiungi i tuoi brani: si ascoltano anche senza rete e non contano negli ascolti Free.';

  return (
    <section id={SECTION_ID} className={styles.card} aria-labelledby="home-local-music">
      <div className={styles.icon} aria-hidden="true">
        <HardDriveDownload />
      </div>
      <div className={styles.copy}>
        <p className={styles.eyebrow}>SUL TUO DISPOSITIVO</p>
        <h2 id="home-local-music" className={styles.title}>
          La tua musica
        </h2>
        <p className={styles.sub}>{sub}</p>
      </div>
      <div className={styles.actions}>
        {hasTracks && tracks ? (
          <>
            <Button
              type="button"
              className={styles.action}
              disabled={!player}
              onClick={() => play(tracks)}
            >
              <Play aria-hidden="true" /> Riproduci tutto
            </Button>
            <Button
              type="button"
              variant="outline"
              className={styles.action}
              disabled={!player}
              aria-label="Riproduci in ordine casuale"
              onClick={() => play(shuffled(tracks))}
            >
              <Shuffle aria-hidden="true" /> Casuale
            </Button>
            <Button asChild variant="ghost" className={styles.action}>
              <Link href={LIBRARY_HREF}>Vedi tutto</Link>
            </Button>
          </>
        ) : (
          <Button asChild className={styles.action}>
            <Link href={LIBRARY_HREF}>
              <Download aria-hidden="true" /> Aggiungi musica offline
            </Link>
          </Button>
        )}
      </div>
    </section>
  );
}
