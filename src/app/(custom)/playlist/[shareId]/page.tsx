// @polsia:user-owned — playlist condivisa con un link pubblico. La pagina è solo il guscio: i dati
// arrivano dal client (GET /api/music/shared/[shareId]). Il titolo resta generico; la descrizione
// dell'anteprima è quella scritta dal proprietario, se c'è (senza indirizzi web, al massimo 160
// caratteri, letta col budget per IP delle anteprime), altrimenti quella generica. La pagina non
// viene indicizzata.
import type { Metadata } from 'next';
import { SharedPlaylistView } from '@/components/custom/music/shared-playlist-view';
import {
  isShareId,
  SHARED_PLAYLIST_DESCRIPTION,
  SHARED_PLAYLIST_IMAGE_ALT,
  sharedPlaylistImagePath,
  sharedPlaylistPath,
  SHARED_PLAYLIST_TITLE as title,
} from '@/lib/music/playlist-share';
import { getSharedPlaylistPreviewDescription } from '@/lib/music/shared-playlists.server';

/** Oltre questo tempo l'anteprima usa la descrizione generica: un database lento non la blocca. */
const DESCRIPTION_LOOKUP_TIMEOUT_MS = 1500;

/**
 * La descrizione del proprietario per og:description, o null (nessuna, playlist non condivisa,
 * troppe anteprime chieste da questo IP, errore o lettura troppo lenta): i metadati non falliscono
 * mai per lei.
 */
async function ownerDescription(shareId: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DESCRIPTION_LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      getSharedPlaylistPreviewDescription(shareId).catch(() => null),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  const { shareId } = await params;
  const valid = isShareId(shareId);
  // The preview image is drawn by ./anteprima.jpg/route.tsx (name, first name, Audius covers).
  const image = valid ? sharedPlaylistImagePath(shareId) : null;
  // og:url: il percorso canonico della playlist (metadataBase lo rende assoluto), lo stesso
  // dell'anteprima in modalità attacco (uam-preview.ts).
  const url = valid ? sharedPlaylistPath(shareId) : null;
  // Un id malformato non arriva al database. In modalità attacco i bot ricevono la descrizione
  // generica (uam-preview.ts non legge il database).
  const description =
    (valid ? await ownerDescription(shareId) : null) ?? SHARED_PLAYLIST_DESCRIPTION;
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
