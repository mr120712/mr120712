// @polsia:user-owned
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PodcastDetail } from '@/components/custom/music/podcast-detail';

export const metadata: Metadata = {
  title: 'Podcast',
  description: 'Episodi del podcast, da ascoltare nel player di Solco.',
};

export default async function PodcastPage({ params }: { params: Promise<{ podcastId: string }> }) {
  const { podcastId } = await params;
  if (!/^[0-9]{1,20}$/.test(podcastId)) notFound();
  return <PodcastDetail podcastId={podcastId} />;
}
