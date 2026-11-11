// @polsia:user-owned
import type { Metadata } from 'next';
import { MusicCollections } from '@/components/custom/music/music-collections';

export const metadata: Metadata = {
  title: 'Preferiti e playlist',
  description: 'Gestisci le tue raccolte private di brani Audius e video YouTube.',
};

export default function DashboardPage() {
  return <MusicCollections />;
}
