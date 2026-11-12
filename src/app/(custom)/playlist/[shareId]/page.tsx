// @polsia:user-owned — playlist condivisa con un link pubblico. La pagina è solo il guscio: i dati
// arrivano dal client (GET /api/music/shared/[shareId]); titolo e descrizione restano generici
// e la pagina non viene indicizzata.
import type { Metadata } from 'next';
import { SharedPlaylistView } from '@/components/custom/music/shared-playlist-view';
import { isShareId, sharedPlaylistImagePath } from '@/lib/music/playlist-share';

const title = 'Playlist condivisa';
const description =
  'Una playlist condivisa su Solco: ascoltala gratis e salvala nella tua Libreria.';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  const { shareId } = await params;
  // The preview image is drawn by ./anteprima.png/route.tsx (name, first name, Audius covers).
  const image = isShareId(shareId) ? sharedPlaylistImagePath(shareId) : null;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      type: 'music.playlist',
      title,
      description,
      ...(image
        ? { images: [{ url: image, width: 1200, height: 630, alt: 'Playlist condivisa su Solco' }] }
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
