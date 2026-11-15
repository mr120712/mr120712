// @polsia:user-owned — /guida: guida per chi usa Solco per la prima volta. Pagina pubblica
// (src/components/custom/require-login.tsx), statica: nessun dato letto nel corpo del Server
// Component. I contenuti sono in src/components/custom/guide/.
import type { Metadata } from 'next';
import { GuidePage } from '@/components/custom/guide/guide-page';

export const metadata: Metadata = {
  title: 'Guida per iniziare',
  description:
    'Come si usa Solco, passo per passo: creare l’account, cercare e ascoltare musica, radio e podcast, salvare i preferiti, installare l’app e capire i piani.',
  alternates: { canonical: '/guida' },
};

export default function GuidaPage() {
  return <GuidePage />;
}
