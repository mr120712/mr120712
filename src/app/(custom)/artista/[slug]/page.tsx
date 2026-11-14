// @polsia:user-owned — pagina d'artista dei "brani in evidenza" (/artista/<slug>): SOLO i brani con
// i diritti dichiarati. Guscio HTML: i dati arrivano dal client (FeaturedArtistView via apiFetch),
// dietro il login come il resto dell'app (RequireLogin). Metadati generici: nessuna lettura qui.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FeaturedArtistView } from '@/components/custom/music/featured-artist-view';
import { isArtistSlug } from '@/lib/music/featured-artists';

export const metadata: Metadata = {
  title: 'Artista',
  description: 'I brani in evidenza di un artista su Solco, da ascoltare nel player.',
  robots: { index: false, follow: false },
};

export default async function FeaturedArtistPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!isArtistSlug(slug)) notFound();
  return <FeaturedArtistView slug={slug} />;
}
