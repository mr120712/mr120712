// @polsia:user-owned — pagina admin «audio.com»: collega (o scollega) l'account audio.com usato dal
// server per aggiungere i brani di audio.com alla ricerca. Vedi audiocom-connection.server.ts.
import type { Metadata } from 'next';
import { AudioComAdmin } from '@/components/custom/music/audiocom-admin';

export const metadata: Metadata = {
  title: 'audio.com — Amministrazione Solco',
  description: 'Collega l’account audio.com usato per la ricerca di Solco.',
};

export default function AudioComAdminPage() {
  return <AudioComAdmin />;
}
