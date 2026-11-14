// @polsia:user-owned — link diretto di un brano in evidenza (/evidenza/<shareId>), pubblico (anche
// senza account: vedi RequireLogin). Esiste SOLO per i brani con i diritti dichiarati in
// diritti.json. La pagina è il guscio: i dati arrivano dal client (FeaturedShareView via apiFetch).
//
// ECCEZIONE VOLUTA E LIMITATA (come playlist/[shareId]/page.tsx): generateMetadata legge l'indice
// in cache dei brani dichiarati (featured-search.server, nessun elenco dello store in più quando è
// già in cache) per mettere nell'anteprima social il titolo VERO «Titolo · Artista». Il dato è
// verificato dal server (mai preso dal link) e la lettura ha un tempo massimo di ~1,5 s: oltre (o
// con l'indice non leggibile) i metadati restano generici, mai un errore. Un id sconosciuto o di
// un brano non dichiarato riceve i metadati generici senza immagine né og:url. Il pathname del file
// non compare mai: solo titolo e artista ripuliti, l'id e i percorsi /evidenza/<id>.
// La pagina non viene indicizzata (robots noindex, follow).
import type { Metadata } from 'next';
import { FeaturedShareView } from '@/components/custom/music/featured-share-view';
import { siteName } from '@/lib/brand';
import { getFeaturedShare } from '@/lib/music/featured-search.server';
import {
  FEATURED_SHARE_DESCRIPTION,
  FEATURED_SHARE_GENERIC_TITLE,
  featuredShareImagePath,
  featuredShareLabel,
  featuredSharePath,
  isFeaturedShareId,
} from '@/lib/music/featured-share';

/** Oltre questo tempo l'anteprima usa i metadati generici: un indice lento non la blocca. */
const LOOKUP_TIMEOUT_MS = 1500;

type Lookup = { kind: 'found'; label: string } | { kind: 'not_found' } | { kind: 'unknown' };

/** Titolo e artista verificati del brano, «non esiste» o «non si sa» (lento, non leggibile). */
async function lookupLabel(shareId: string): Promise<Lookup> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Lookup>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unknown' }), LOOKUP_TIMEOUT_MS);
  });
  const lookup = getFeaturedShare(shareId)
    .then((result): Lookup => {
      if (result.outcome === 'found') {
        return {
          kind: 'found',
          label: featuredShareLabel(result.track.title, result.track.artist),
        };
      }
      return result.outcome === 'not_found' ? { kind: 'not_found' } : { kind: 'unknown' };
    })
    .catch((): Lookup => ({ kind: 'unknown' }));
  try {
    return await Promise.race([lookup, timeout]);
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
  const description = FEATURED_SHARE_DESCRIPTION;
  const robots = { index: false, follow: true };
  // Un id malformato non arriva all'indice.
  const lookup: Lookup = isFeaturedShareId(shareId)
    ? await lookupLabel(shareId)
    : { kind: 'not_found' };
  if (lookup.kind === 'not_found') {
    return { title: FEATURED_SHARE_GENERIC_TITLE, description, robots };
  }
  const title = lookup.kind === 'found' ? lookup.label : FEATURED_SHARE_GENERIC_TITLE;
  // og:url: il percorso canonico (metadataBase lo rende assoluto). L'immagine la disegna
  // ./anteprima.jpg/route.tsx dai soli dati dell'indice.
  const url = featuredSharePath(shareId);
  const image = {
    url: featuredShareImagePath(shareId),
    type: 'image/jpeg',
    width: 1200,
    height: 630,
    alt: title,
  };
  return {
    title,
    description,
    robots,
    // Next sostituisce (non unisce) l'openGraph del layout: nome del sito e lingua vanno ripetuti,
    // come nella pagina d'anteprima della modalità attacco (uam-preview).
    openGraph: {
      type: 'music.song',
      siteName,
      locale: 'it_IT',
      title,
      description,
      url,
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image.url] },
  };
}

export default async function FeaturedSharePage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  return <FeaturedShareView shareId={shareId} />;
}
