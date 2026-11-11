// @polsia:user-owned
import type { Metadata } from 'next';
import { CommunityBrowser } from '@/components/custom/community/community-browser';

export const metadata: Metadata = {
  title: 'Community Solco',
  description: 'Scopri e segui i profili pubblici di fan e artisti su Solco.',
};

export default function CommunityPage() {
  return <CommunityBrowser />;
}
