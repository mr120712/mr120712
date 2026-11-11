// @polsia:user-owned
import type { Metadata } from 'next';
import { AlbumDetail } from '@/components/custom/music/album-detail';

export const metadata: Metadata = {
  title: 'Album',
  description: 'Metadati e tracklist dal catalogo musicale, con accesso verificato per ogni brano.',
};

export default async function AlbumPage({ params }: { params: Promise<{ albumId: string }> }) {
  const { albumId } = await params;
  return <AlbumDetail albumId={albumId} />;
}
