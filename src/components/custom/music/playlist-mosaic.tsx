// @polsia:user-owned — copertina automatica di una playlist: un mosaico 2×2 con le prime 4
// copertine diverse (nell'ordine della playlist) quando ce ne sono almeno 4, una sola copertina
// intera con 1-3 copertine, altrimenti l'iniziale del nome su un gradiente del brand. Sempre
// quadrata (aspect-ratio fisso: nessuno spostamento del layout), immagini caricate solo quando
// servono (loading="lazy") e decorative (alt vuoto: il nome della playlist accanto la descrive).
// Una copertina che non si carica lascia il colore di ripiego al suo posto e il mosaico resta
// allineato; con 1-3 copertine si passa alla successiva; se nessuna si carica torna l'iniziale.
'use client';

import { useState } from 'react';
import { artInitial } from '@/lib/music/art-initial';
import styles from './playlist-mosaic.module.css';

/** Quante copertine compongono il mosaico (2×2). */
export const PLAYLIST_MOSAIC_TILES = 4;

type CoveredItem = { artworkUrl?: string | null };

/**
 * Le prime `limit` copertine diverse (stesso indirizzo = stessa copertina), nell'ordine della
 * playlist; gli elementi senza copertina vengono saltati.
 */
export function playlistMosaicCovers(
  items: ReadonlyArray<CoveredItem>,
  limit = PLAYLIST_MOSAIC_TILES,
): string[] {
  const covers: string[] = [];
  for (const item of items) {
    if (covers.length >= limit) break;
    const url = item.artworkUrl?.trim();
    if (url && !covers.includes(url)) covers.push(url);
  }
  return covers;
}

export type PlaylistMosaicLayout = 'grid' | 'single' | 'fallback';

/** grid: 4 copertine diverse; single: da 1 a 3 (la prima che si carica); fallback: nessuna. */
export function playlistMosaicLayout(covers: ReadonlyArray<string>): PlaylistMosaicLayout {
  if (covers.length >= PLAYLIST_MOSAIC_TILES) return 'grid';
  return covers.length > 0 ? 'single' : 'fallback';
}

export function PlaylistMosaic({
  name,
  items,
  className,
}: {
  /** Nome della playlist: da qui l'iniziale del ripiego tipografico. */
  name: string;
  /** Gli elementi nell'ordine in cui la playlist li mostra. */
  items: ReadonlyArray<CoveredItem>;
  /** Larghezza e angoli dal contenitore; il mosaico resta sempre quadrato. */
  className?: string;
}) {
  const covers = playlistMosaicCovers(items);
  const layout = playlistMosaicLayout(covers);
  /** Copertine che non si sono caricate (per indirizzo: una copertina nuova riprova). */
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const loadable = covers.filter((src) => !failed.has(src));
  // Nel mosaico ogni riquadro resta al suo posto; con 1-3 copertine si prova la prossima che non
  // è fallita, e l'iniziale torna solo quando nessuna si carica.
  const shown = layout === 'grid' ? covers : loadable.slice(0, 1);
  const rootClass = [styles.mosaic, className].filter(Boolean).join(' ');

  if (layout === 'fallback' || loadable.length === 0) {
    return (
      <div className={rootClass} data-layout="fallback" aria-hidden="true">
        <span className={styles.initial}>{artInitial(name)}</span>
      </div>
    );
  }

  return (
    <div className={rootClass} data-layout={layout} aria-hidden="true">
      {shown.map((src) =>
        failed.has(src) ? (
          <span key={src} className={styles.tileFallback} data-tile="failed" />
        ) : (
          // biome-ignore lint/performance/noImgElement: copertina remota decorativa; next/image (unoptimized) non aggiungerebbe nulla e il riquadro quadrato evita già spostamenti.
          <img
            key={src}
            className={styles.tile}
            src={src}
            alt=""
            width={layout === 'grid' ? 160 : 320}
            height={layout === 'grid' ? 160 : 320}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() =>
              setFailed((current) => (current.has(src) ? current : new Set(current).add(src)))
            }
          />
        ),
      )}
    </div>
  );
}
