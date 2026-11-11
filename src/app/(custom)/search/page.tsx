// @polsia:user-owned
import type { Metadata } from 'next';
import { MusicSearch } from '@/components/custom/music/music-search';

export const metadata: Metadata = {
  title: 'Cerca musica',
  description:
    'Cerca musica su Audius o video musicali su YouTube e ascolta i brani solo nei player autorizzati.',
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  const initialQuery = typeof params.q === 'string' ? params.q : '';
  return <MusicSearch initialQuery={initialQuery} />;
}
