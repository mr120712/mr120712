// @polsia:user-owned — pagina /admin/visitatori: statistiche di visita aggregate (nessun dato
// personale, nessun indirizzo IP). Il layout /admin verifica il ruolo; la route
// /api/admin/visitors ricontrolla.
import type { Metadata } from 'next';
import { VisitorsDashboard } from '@/components/custom/admin/visitors-dashboard';

export const metadata: Metadata = {
  title: 'Visitatori — Amministrazione Solco',
  description:
    'Visitatori e pagine aperte di Solco: oggi, ultimi 7 e 30 giorni, pagine più viste, Paesi, provenienze e dispositivi.',
};

export default function VisitorsAdminPage() {
  return <VisitorsDashboard />;
}
