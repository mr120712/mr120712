// @polsia:user-owned — libreria pubblica dei brani caricati dagli utenti (Vercel Blob).
import type { Metadata } from 'next';
import { PublicLibraryView } from '@/components/custom/music/public-library-view';

export const metadata: Metadata = {
  title: 'Libreria pubblica',
  description:
    'Brani caricati dagli utenti di Solco, ascoltabili da tutti. Carica i tuoi (solo musica tua o libera, pubblico dominio o Creative Commons).',
  alternates: { canonical: '/pubblica' },
};

export default function PublicUploadsPage() {
  return <PublicLibraryView />;
}
