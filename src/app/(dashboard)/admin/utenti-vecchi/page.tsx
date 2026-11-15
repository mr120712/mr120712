// @polsia:user-owned — pagina /admin/utenti-vecchi: controllo dei database indicati dalle variabili
// d'ambiente e trasferimento degli account del vecchio sito. Il layout /admin verifica il ruolo;
// le route /api/admin/legacy-users ricontrollano a ogni richiesta.
import type { Metadata } from 'next';
import { LegacyUsersPanel } from '@/components/custom/admin/legacy-users-panel';

export const metadata: Metadata = {
  title: 'Utenti del vecchio sito — Amministrazione Solco',
  description:
    'Trova il database del vecchio sito e trasferisci i suoi account, con anteprima e conferma.',
};

export default function LegacyUsersAdminPage() {
  return <LegacyUsersPanel />;
}
