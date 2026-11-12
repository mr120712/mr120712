// @polsia:user-owned
import type { Metadata } from 'next';
import { UnifiedSearchResults } from '@/components/custom/music/unified-search-results';

export const metadata: Metadata = {
  title: 'Cerca',
  description:
    'Un solo campo per cercare insieme brani e video musicali, radio e podcast e ascoltarli nel player di Solco.',
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; ai?: string | string[] }>;
}) {
  const params = await searchParams;
  const initialQuery = typeof params.q === 'string' ? params.q.slice(0, 80) : '';
  return <UnifiedSearchResults initialQuery={initialQuery} initialAi={params.ai === '1'} />;
}
