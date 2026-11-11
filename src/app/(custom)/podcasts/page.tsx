// @polsia:user-owned
import type { Metadata } from 'next';
import { PodcastDirectory } from '@/components/custom/music/podcast-directory';

export const metadata: Metadata = {
  title: 'Podcast',
  description: 'Scopri i podcast in classifica, cerca uno show e ascolta gli episodi.',
  alternates: { canonical: '/podcasts' },
};

export default async function PodcastsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  return (
    <PodcastDirectory initialQuery={typeof params.q === 'string' ? params.q.slice(0, 80) : ''} />
  );
}
