// @polsia:user-owned — pagina pubblica di stato (/stato), servita anche su status.solcomusic.online.
import type { Metadata } from 'next';
import { StatusView } from '@/components/custom/status/status-view';

export const metadata: Metadata = {
  title: 'Stato del servizio',
  description:
    'Stato in tempo quasi reale dei sistemi di Solco: database, accesso, ricerca e cataloghi musicali.',
  alternates: { canonical: '/stato' },
};

export default function StatusPage() {
  return (
    <main className="px-4 py-10 sm:py-16">
      <StatusView />
    </main>
  );
}
