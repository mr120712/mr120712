// @polsia:user-owned
import type { Metadata } from 'next';
import { TikTokAdmin } from '@/components/custom/music/tiktok-admin';

export const metadata: Metadata = {
  title: 'Video TikTok — Amministrazione Solco',
  description: 'Scegli i video TikTok pubblici mostrati in Solco.',
};

export default function TikTokAdminPage() {
  return <TikTokAdmin />;
}
