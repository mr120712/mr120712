// @polsia:user-owned
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GenreDetail } from '@/components/custom/music/genre-detail';
import { siteName } from '@/lib/brand';
import { findGenre, genreCatalog } from '@/lib/music/genre-catalog';

/**
 * La scheda generica di Solco (src/app/opengraph-image.tsx). Va indicata di nuovo: un openGraph
 * della pagina sostituisce per intero quello del layout, immagine compresa.
 */
const SITE_OG_IMAGE = {
  url: '/opengraph-image',
  type: 'image/png',
  width: 1200,
  height: 630,
  alt: siteName,
};

export function generateStaticParams() {
  return genreCatalog.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const genre = findGenre((await params).slug);
  if (!genre) return {};
  // Le playlist divertenti si presentano per quello che sono; i generi con la formula di sempre.
  const description =
    genre.family === 'divertenti'
      ? `${genre.description} La playlist divertente di Solco, pronta da ascoltare: brani, radio e altro.`
      : `${genre.description} Brani, radio e playlist ${genre.name} su Solco.`;
  const path = `/generi/${genre.slug}`;
  // Il link condiviso (ShareButton di genre-detail) mostra il genere anche nell'anteprima social.
  const socialTitle = `${genre.name} su Solco`;
  return {
    title: genre.name,
    description,
    alternates: { canonical: path },
    openGraph: {
      title: socialTitle,
      description,
      type: 'website',
      url: path,
      images: [SITE_OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description,
      images: [SITE_OG_IMAGE.url],
    },
  };
}

export default async function GenrePage({ params }: { params: Promise<{ slug: string }> }) {
  const genre = findGenre((await params).slug);
  if (!genre) notFound();
  return <GenreDetail genre={genre} />;
}
