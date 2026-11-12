// @polsia:user-owned
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LibraryView } from '@/components/custom/music/library-view';

export const metadata: Metadata = {
  title: 'Libreria',
  description:
    'La tua musica sul dispositivo, le playlist, i preferiti, le radio salvate, i podcast seguiti e la cronologia.',
  robots: { index: false },
};

export default function LibraryPage() {
  return (
    <Suspense>
      <LibraryView />
    </Suspense>
  );
}
