// @polsia:user-owned
import type { Metadata } from 'next';
import { MusicRightsAdmin } from '@/components/custom/music/music-rights-admin';

export const metadata: Metadata = {
  title: 'Diritti di ascolto — Amministrazione Solco',
  description:
    'Registro amministrativo privato delle fonti audio e delle prove di streaming Solco.',
};

export default function MusicRightsAdminPage() {
  return <MusicRightsAdmin />;
}
