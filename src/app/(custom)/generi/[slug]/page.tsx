// @polsia:user-owned
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GenreDetail } from '@/components/custom/music/genre-detail';
import { findGenre, genreCatalog } from '@/lib/music/genre-catalog';

export function generateStaticParams() {
  return genreCatalog.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const genre = findGenre((await params).slug);
  return genre
    ? {
        title: genre.name,
        description: `${genre.description} Brani, radio e playlist ${genre.name} su Solco.`,
        alternates: { canonical: `/generi/${genre.slug}` },
      }
    : {};
}

export default async function GenrePage({ params }: { params: Promise<{ slug: string }> }) {
  const genre = findGenre((await params).slug);
  if (!genre) notFound();
  return <GenreDetail genre={genre} />;
}
