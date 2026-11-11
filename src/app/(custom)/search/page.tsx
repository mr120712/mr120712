// @polsia:user-owned
import type { Metadata } from 'next';
import { MusicSearchPage } from '@/components/custom/music/music-search-page';

export const metadata: Metadata = {
  title: 'Cerca musica',
  description:
    'Cerca brani e artisti su Audius, video musicali su YouTube, stazioni radio e podcast.',
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  const initialQuery = typeof params.q === 'string' ? params.q : '';
  return <MusicSearchPage initialQuery={initialQuery} />;
}
