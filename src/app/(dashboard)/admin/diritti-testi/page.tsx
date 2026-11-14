// @polsia:user-owned — pagina /admin/diritti-testi: perché un brano in evidenza è (o non è)
// ricercabile e se il suo testo è disponibile. Diagnosi soltanto: mai il testo dei brani. Il
// layout /admin verifica il ruolo; la route /api/admin/featured-rights ricontrolla.
import type { Metadata } from 'next';
import { FeaturedRightsDashboard } from '@/components/custom/admin/featured-rights-dashboard';

export const metadata: Metadata = {
  title: 'Diritti e testi — Amministrazione Solco',
  description:
    'Diagnosi di diritti.json e dei testi dei brani in evidenza: che cosa è ricercabile e perché.',
};

export default function FeaturedRightsAdminPage() {
  return <FeaturedRightsDashboard />;
}
