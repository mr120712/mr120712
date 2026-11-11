// @polsia:user-owned
import type { Metadata } from 'next';
import { CommunityProfile } from '@/components/custom/community/community-profile';

export const metadata: Metadata = {
  title: 'Profilo Solco',
  description: 'Profilo pubblico della community Solco.',
};

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;
  return <CommunityProfile profileId={profileId} />;
}
