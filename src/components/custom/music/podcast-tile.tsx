// @polsia:user-owned — riquadro di un podcast con link alla scheda episodi.
'use client';

import { EyeOff } from 'lucide-react';
import Link from 'next/link';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useLibrary } from '@/components/custom/music/library-context';
import type { Podcast } from '@/lib/contracts/library';
import styles from './discover.module.css';

export function PodcastArt({ podcast }: { podcast: Pick<Podcast, 'title' | 'artworkUrl'> }) {
  return <FallbackArt src={podcast.artworkUrl} label={podcast.title} size={300} />;
}

export function PodcastTile({
  podcast,
  allowHide = true,
}: {
  podcast: Podcast;
  allowHide?: boolean;
}) {
  const library = useLibrary();
  const href = `/podcasts/${encodeURIComponent(podcast.id)}`;
  return (
    <article className={styles.tile}>
      <Link href={href} className={styles.tileArt} aria-label={`Apri il podcast ${podcast.title}`}>
        <PodcastArt podcast={podcast} />
      </Link>
      <Link href={href} className={styles.tileTitle} title={podcast.title}>
        {podcast.title}
      </Link>
      <span className={styles.tileMeta}>{podcast.author ?? podcast.genre ?? 'Podcast'}</span>
      {library.signedIn && allowHide ? (
        <div className={styles.tileActions}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Non mi interessa: ${podcast.title}`}
            onClick={() =>
              void library.mutate(
                {
                  action: 'hide',
                  item: { kind: 'podcast', itemId: podcast.id, label: podcast.title },
                },
                'Non vedrai più questo podcast nei consigli.',
              )
            }
          >
            <EyeOff aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </article>
  );
}
