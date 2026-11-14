// @polsia:user-owned — pagina /admin/iscritti: numeri aggregati sugli account (nessun dato
// personale). Il layout /admin verifica il ruolo; la route /api/admin/signups ricontrolla.
import type { Metadata } from 'next';
import { SignupsDashboard } from '@/components/custom/admin/signups-dashboard';

export const metadata: Metadata = {
  title: 'Iscritti — Amministrazione Solco',
  description:
    'Totale degli account di Solco, nuove iscrizioni e andamento degli ultimi 30 giorni.',
};

export default function SignupsAdminPage() {
  return <SignupsDashboard />;
}
