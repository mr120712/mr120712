// @polsia:user-owned
import type { Metadata } from 'next';
import { CommunityConnections } from '@/components/custom/community/community-connections';

export const metadata: Metadata = {
  title: 'Follower — Solco',
  description: 'La lista dei follower visibili di un profilo Solco.',
};

export default async function FollowersPage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;
  return <CommunityConnections profileId={profileId} list="followers" />;
}
