// @polsia:user-owned — playlist condivisa con un link pubblico. La pagina è solo il guscio: i dati
// arrivano dal client (GET /api/music/shared/[shareId]); titolo e descrizione restano generici
// e la pagina non viene indicizzata.
import type { Metadata } from 'next';
import { SharedPlaylistView } from '@/components/custom/music/shared-playlist-view';
import {
  SHARED_PLAYLIST_DESCRIPTION as description,
  isShareId,
  SHARED_PLAYLIST_IMAGE_ALT,
  sharedPlaylistImagePath,
  sharedPlaylistPath,
  SHARED_PLAYLIST_TITLE as title,
} from '@/lib/music/playlist-share';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  const { shareId } = await params;
  // The preview image is drawn by ./anteprima.jpg/route.tsx (name, first name, Audius covers).
  const image = isShareId(shareId) ? sharedPlaylistImagePath(shareId) : null;
  // og:url: il percorso canonico della playlist (metadataBase lo rende assoluto), lo stesso
  // dell'anteprima in modalità attacco (uam-preview.ts).
  const url = isShareId(shareId) ? sharedPlaylistPath(shareId) : null;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      type: 'music.playlist',
      title,
      description,
      ...(url ? { url } : {}),
      ...(image
        ? {
            images: [
              {
                url: image,
                type: 'image/jpeg',
                width: 1200,
                height: 630,
                alt: SHARED_PLAYLIST_IMAGE_ALT,
              },
            ],
          }
        : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function SharedPlaylistPage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  return <SharedPlaylistView shareId={shareId} />;
}
