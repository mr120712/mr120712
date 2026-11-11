// @polsia:user-owned
import type { Metadata } from 'next';
import { YouTubeSearchPage } from '@/components/custom/music/youtube-search-page';

export const metadata: Metadata = {
  title: 'Cerca',
  description: 'Cerca brani e video musicali, radio e podcast e ascoltali nel player di Solco.',
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  const initialQuery = typeof params.q === 'string' ? params.q.slice(0, 80) : '';
  return <YouTubeSearchPage initialQuery={initialQuery} />;
}
