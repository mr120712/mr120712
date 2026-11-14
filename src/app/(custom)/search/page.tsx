// @polsia:user-owned
import type { Metadata } from 'next';
import { UnifiedSearchResults } from '@/components/custom/music/unified-search-results';
import { sharedSongFromParams, songPreviewImagePath } from '@/lib/business/social-share';

type SearchParams = Promise<
  { q?: string | string[]; ai?: string | string[] } & Record<string, string | string[] | undefined>
>;

const baseMetadata: Metadata = {
  title: 'Cerca',
  description:
    'Un solo campo per cercare insieme brani e video musicali, radio e podcast e ascoltarli nel player di Solco.',
};

/**
 * Un brano condiviso dal player (/search?q=…&t=…&a=…&au=…): titolo e scheda per l'anteprima del
 * link su WhatsApp, Telegram, X, Facebook (vedi search/anteprima.jpg). Solo i parametri: nessun
 * dato letto qui, la pagina resta la ricerca di sempre. Titolo e artista sono testo del link già
 * ripulito (sharedSongFromParams, niente indirizzi web); l'immagine è l'indirizzo canonico della
 * scheda, lo stesso che allega il player (con un id Audius, i dati della scheda arrivano da Audius).
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const song = sharedSongFromParams(await searchParams);
  if (!song) return baseMetadata;
  const name = song.title || 'Musica su Solco';
  const title = song.title && song.artist ? `${song.title} · ${song.artist}` : name;
  const description = 'Ascoltalo su Solco: musica, radio dal vivo e podcast in un solo player.';
  const image = {
    url: songPreviewImagePath(song),
    type: 'image/jpeg',
    width: 1200,
    height: 630,
    alt: title,
  };
  return {
    title,
    description,
    // Una ricerca resta fuori dai motori di ricerca anche quando arriva da un link condiviso.
    robots: { index: false, follow: true },
    openGraph: { title, description, type: 'music.song', images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image.url] },
  };
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const initialQuery = typeof params.q === 'string' ? params.q.slice(0, 80) : '';
  return <UnifiedSearchResults initialQuery={initialQuery} initialAi={params.ai === '1'} />;
}
