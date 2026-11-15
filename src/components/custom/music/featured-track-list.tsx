// @polsia:user-owned — pezzi condivisi delle pagine dei "brani in evidenza" con un elenco di brani
// DICHIARATI (pagina d'artista /artista/<slug> e «Mostra tutti» di una sezione /cartella/<id>):
// elenco numerato (un tocco suona il brano con la coda della pagina, o mette in pausa quello in
// corso), «Condividi» accanto alle righe dei brani con `shareId`, coda di «Riproduci tutto» /
// «Casuale», link alla Home, scheletro di caricamento e lettura degli errori dell'API. Stessi stili
// della pagina d'artista (featured-artist-view.module.css) e stessa riproduzione della Home
// (playHomeTrack: stesso elemento del player, stesso percorso di streaming, stesse regole).
'use client';

import { ArrowLeft, Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { FeaturedShareButton } from '@/components/custom/music/featured-share-button';
import { homeTrackToTrack, playHomeTrack } from '@/components/custom/music/live-tracks';
import { Button } from '@/components/ui/button';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import styles from './featured-artist-view.module.css';

/** Quanto serve del player (useMusicPlayer() lo soddisfa): lo stesso di playHomeTrack. */
export type FeaturedQueuePlayer = Parameters<typeof playHomeTrack>[0];
/** Più lo stato, per segnare il brano in corso. */
export type FeaturedListPlayer = FeaturedQueuePlayer & { status: string };

/** «Condividi» di una riga: tondo, discreto, grande quanto l'icona di riproduzione. */
const ROW_SHARE_BUTTON = 'size-9 rounded-full text-muted-foreground hover:text-foreground';

/** «1 brano» / «N brani». */
export function songCount(count: number): string {
  return count === 1 ? '1 brano' : `${count} brani`;
}

/**
 * Un errore dell'API letto per la pagina: 'gone' = 404/not_found (nessun brano dichiarato o link
 * non valido: stato vuoto), altrimenti un errore da riprovare.
 */
export function featuredLoadFailure(error: unknown): 'gone' | 'error' {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown })
      : null;
  if (cause?.error === 'not_found') return 'gone';
  const match = error instanceof Error ? /\((\d{3})\)$/.exec(error.message) : null;
  return match?.[1] === '404' ? 'gone' : 'error';
}

/**
 * «Riproduci tutto» / «Casuale»: la coda della pagina dal suo primo brano, con playHomeTrack come
 * in Home. Se il primo brano è già quello in corso, playHomeTrack lo metterebbe in pausa: qui
 * invece la coda riparte (stesso elemento e stesso percorso di playHomeTrack).
 */
export function playFeaturedQueue(player: FeaturedQueuePlayer, queue: readonly HomeTrack[]): void {
  const [first] = queue;
  if (!first) return;
  const track = homeTrackToTrack(first);
  if (player.currentTrack?.qualifiedId === track.qualifiedId) {
    void player.playTrack(track, track.streamUrl ?? '', queue.map(homeTrackToTrack));
    return;
  }
  playHomeTrack(player, first, queue);
}

/** «Torna alla Home» (un <Button asChild><Link/></Button>). */
export function FeaturedBackLink() {
  return (
    <Button asChild variant="ghost" size="sm" className={styles.back}>
      <Link href="/">
        <ArrowLeft aria-hidden="true" /> Torna alla Home
      </Link>
    </Button>
  );
}

/** Scheletro della pagina mentre carica, con l'annuncio per lo screen reader. */
export function FeaturedListSkeleton({
  label,
  className,
}: {
  /** Annuncio per lo screen reader (es. «Caricamento dell'artista…»). */
  label: string;
  /** Classe in più per la pagina (es. la forma della copertina con --hero-cover-radius). */
  className?: string;
}) {
  return (
    <main className={[styles.page, className].filter(Boolean).join(' ')} aria-busy="true">
      <FeaturedBackLink />
      <output className="sr-only">{label}</output>
      <div className={styles.hero} aria-hidden="true">
        <div className={`${styles.skeleton} ${styles.skeletonCover}`} />
        <div className={styles.heroCopy}>
          <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
          <div className={`${styles.skeleton} ${styles.skeletonTitle}`} />
          <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
        </div>
      </div>
      <div className={styles.tracks} aria-hidden="true">
        {['a', 'b', 'c', 'd'].map((key) => (
          <div key={key} className={`${styles.skeleton} ${styles.skeletonRow}`} />
        ))}
      </div>
    </main>
  );
}

/**
 * L'elenco dei brani della pagina: intestazione «Brani · N brani», righe numerate (un tocco suona
 * il brano con la coda di tutta la pagina, o mette in pausa/riprende quello in corso) e, accanto
 * alle righe dei brani dichiarati con `shareId`, il loro «Condividi». Il brano in corso è segnato
 * (aria-current, barre animate solo senza «riduci movimento») e annunciato quando cambia.
 */
export function FeaturedTrackList({
  player,
  tracks,
  fallbackArtist,
  headingId,
  rowClassName,
}: {
  player: FeaturedListPlayer;
  tracks: readonly HomeTrack[];
  /** Il nome mostrato per un brano senza artista nel nome del file. */
  fallbackArtist: string;
  /** Id dell'intestazione «Brani» (unico nella pagina). */
  headingId: string;
  /** Classe in più per ogni riga (es. rendering differito negli elenchi lunghi). */
  rowClassName?: string;
}) {
  const nowPlaying =
    player.status === 'playing'
      ? tracks.find((track) => player.currentTrack?.qualifiedId === `upload:${track.id}`)
      : undefined;
  const rowClass = [styles.row, rowClassName].filter(Boolean).join(' ');

  return (
    <section className={styles.listSection} aria-labelledby={headingId}>
      <div className={styles.listHeading}>
        <h2 id={headingId}>Brani</h2>
        <p>{songCount(tracks.length)}</p>
      </div>
      {/* Safari/VoiceOver tolgono la semantica di lista a un elenco con list-style: none. */}
      {/* biome-ignore lint/a11y/noRedundantRoles: il ruolo esplicito tiene annunciato l'elenco. */}
      {/* biome-ignore lint/a11y/useSemanticElements: è già un <ol>; il ruolo è la correzione per Safari. */}
      <ol className={styles.tracks} role="list">
        {tracks.map((track, index) => {
          const current = player.currentTrack?.qualifiedId === `upload:${track.id}`;
          const playing = current && player.status === 'playing';
          const byline = track.artist ?? fallbackArtist;
          const label = playing
            ? `Metti in pausa ${track.title} di ${byline}`
            : current
              ? `Riprendi ${track.title} di ${byline}`
              : `Riproduci ${track.title} di ${byline}`;
          return (
            <li
              key={track.id}
              className={rowClass}
              data-current={current ? 'true' : undefined}
              data-shareable={track.shareId ? 'true' : undefined}
            >
              <button
                type="button"
                className={styles.rowButton}
                aria-label={label}
                aria-current={current ? 'true' : undefined}
                onClick={() => playHomeTrack(player, track, tracks)}
              >
                <span className={styles.index} aria-hidden="true">
                  {current ? (
                    <span className={styles.bars} data-playing={playing ? 'true' : undefined}>
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    String(index + 1).padStart(2, '0')
                  )}
                </span>
                <span className={styles.cover}>
                  <FallbackArt src={track.artworkUrl} label={track.title} size={52} />
                </span>
                <span className={styles.copy}>
                  <strong title={track.title}>{track.title}</strong>
                  <span className={styles.trackArtist} title={byline}>
                    {byline}
                  </span>
                </span>
                <span className={styles.playIcon} aria-hidden="true">
                  {playing ? <Pause /> : <Play />}
                </span>
              </button>
              {/* Link diretto «Condividi» (brani dichiarati): accanto alla riga, mai dentro il
                  pulsante che la suona. */}
              <FeaturedShareButton
                track={track}
                className={styles.rowShare}
                buttonClassName={ROW_SHARE_BUTTON}
              />
            </li>
          );
        })}
      </ol>
      {/* Lo stato del brano in corso, annunciato quando cambia. */}
      <output className="sr-only" aria-live="polite">
        {nowPlaying ? `In riproduzione: ${nowPlaying.title}` : ''}
      </output>
    </section>
  );
}
