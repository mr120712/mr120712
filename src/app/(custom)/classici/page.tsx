// @polsia:user-owned
import type { Metadata } from 'next';
import { ClassicsView } from '@/components/custom/music/classics-view';

export const metadata: Metadata = {
  title: 'Classici per decennio',
  description:
    'Playlist che ripercorrono i suoni degli anni 60, 70, 80 e 90, dal catalogo musicale lecito di Solco.',
  alternates: { canonical: '/classici' },
};

export default function ClassiciPage() {
  return <ClassicsView />;
}
