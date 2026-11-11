// @polsia:user-owned — riquadro di una stazione radio: riproduci, salva, nascondi.
'use client';

import { EyeOff, Heart, Pause, Play } from 'lucide-react';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useLibrary } from '@/components/custom/music/library-context';
import { stationToSaved, stationToTrack } from '@/components/custom/music/live-tracks';
import { trackStreamPath, useMusicPlayer } from '@/components/custom/music/music-player';
import type { RadioStation } from '@/lib/contracts/library';
import styles from './discover.module.css';

export function useStationPlayback() {
  const player = useMusicPlayer();
  return {
    isPlaying: (station: RadioStation) =>
      player.currentTrack?.qualifiedId === `radio:${station.id}` && player.status === 'playing',
    play: (station: RadioStation, queue: RadioStation[] = [station]) => {
      const track = stationToTrack(station);
      if (player.currentTrack?.qualifiedId === track.qualifiedId) {
        void player.togglePlayback();
        return;
      }
      const path = trackStreamPath(track);
      if (path) void player.playTrack(track, path, queue.map(stationToTrack));
    },
  };
}

export function StationArt({ station }: { station: Pick<RadioStation, 'name' | 'artworkUrl'> }) {
  return <FallbackArt src={station.artworkUrl} label={station.name} size={240} />;
}

export function StationTile({
  station,
  queue,
  allowHide = true,
}: {
  station: RadioStation;
  queue?: RadioStation[];
  allowHide?: boolean;
}) {
  const playback = useStationPlayback();
  const library = useLibrary();
  const playing = playback.isPlaying(station);
  const saved = library.isStationSaved(station.id);
  const meta = [station.country, station.tags[0]].filter(Boolean).join(' · ');

  return (
    <article className={styles.tile}>
      <div className={styles.tileArt}>
        <StationArt station={station} />
        <button
          type="button"
          className={styles.tilePlay}
          onClick={() => playback.play(station, queue)}
          aria-label={
            playing ? `Metti in pausa ${station.name}` : `Ascolta ${station.name} in diretta`
          }
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
      </div>
      <strong className={styles.tileTitle} title={station.name}>
        {station.name}
      </strong>
      <span className={styles.tileMeta}>
        <span className={styles.liveDot} aria-hidden="true" />
        {meta || 'In diretta'}
      </span>
      {library.signedIn ? (
        <div className={styles.tileActions}>
          <button
            type="button"
            className={styles.iconButton}
            aria-pressed={saved}
            aria-label={
              saved ? `Rimuovi ${station.name} dalle radio salvate` : `Salva ${station.name}`
            }
            onClick={() =>
              void library.mutate(
                saved
                  ? { action: 'unsave_station', stationId: station.id }
                  : { action: 'save_station', station: stationToSaved(station) },
                saved ? 'Radio rimossa dalla Libreria.' : 'Radio salvata nella Libreria.',
              )
            }
          >
            <Heart aria-hidden="true" fill={saved ? 'currentColor' : 'none'} />
          </button>
          {allowHide ? (
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`Non mi interessa: ${station.name}`}
              onClick={() =>
                void library.mutate(
                  {
                    action: 'hide',
                    item: { kind: 'station', itemId: station.id, label: station.name },
                  },
                  'Non vedrai più questa radio nei consigli.',
                )
              }
            >
              <EyeOff aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
