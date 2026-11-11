// @polsia:user-owned
import type { Metadata } from 'next';
import { CommunityConnections } from '@/components/custom/community/community-connections';

export const metadata: Metadata = {
  title: 'Profili seguiti — Solco',
  description: 'La lista dei profili seguiti visibili di un profilo Solco.',
};

export default async function FollowingPage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;
  return <CommunityConnections profileId={profileId} list="following" />;
}
