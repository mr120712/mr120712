// @polsia:user-owned — libreria pubblica dei brani caricati dagli utenti (Vercel Blob). Con la
// libreria spenta (src/lib/features.ts) i vecchi link vanno alla Home: un 307 HTTP da
// next.user-config.ts (anche senza JS e per le anteprime dei link) e, come riserva, il redirect qui
// sotto. Il codice resta qui per riattivarla.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PublicLibraryView } from '@/components/custom/music/public-library-view';
import { publicUploadsEnabled } from '@/lib/features';

export const metadata: Metadata = {
  title: 'Libreria pubblica',
  description:
    'Brani caricati dagli utenti di Solco, ascoltabili da tutti. Carica i tuoi (solo musica tua o libera, pubblico dominio o Creative Commons).',
  alternates: { canonical: '/pubblica' },
};

export default function PublicUploadsPage() {
  if (!publicUploadsEnabled()) redirect('/');
  return <PublicLibraryView />;
}
