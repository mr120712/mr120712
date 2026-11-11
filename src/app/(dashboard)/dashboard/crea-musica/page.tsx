// @polsia:user-owned
import type { Metadata } from 'next';
import { SongCreator } from '@/components/custom/music/song-creator';

export const metadata: Metadata = {
  title: 'Crea un brano — Solco Pro',
  description: 'Descrivi un brano originale e gestisci le tue creazioni musicali.',
};

export default function CreateMusicPage() {
  return <SongCreator />;
}
