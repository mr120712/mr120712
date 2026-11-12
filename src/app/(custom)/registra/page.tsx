// @polsia:user-owned
import type { Metadata } from 'next';
import { RecordingsStudio } from '@/components/custom/music/recordings-studio';

export const metadata: Metadata = {
  title: 'Registra un brano',
  description:
    'Registra la tua musica dal microfono: resta ospitata interamente su Solco e la riascolti dalla tua Libreria.',
  alternates: { canonical: '/registra' },
};

export default function RegistraPage() {
  return <RecordingsStudio />;
}
