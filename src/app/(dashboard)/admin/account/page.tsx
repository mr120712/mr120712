// @polsia:user-owned — pagina /admin/account («Gestione account»): ogni account con il suo UID
// leggibile, il modo di accesso, l'email verificata, il ruolo e il Premium attivo; da qui
// l'amministratore concede o revoca il Premium illimitato a un'email. Il layout /admin verifica il
// ruolo; le rotte /api/admin/accounts e /api/admin/premium-grants ricontrollano a ogni richiesta.
import type { Metadata } from 'next';
import { AccountManagementPanel } from '@/components/custom/admin/account-management';

export const metadata: Metadata = {
  title: 'Gestione account — Amministrazione Solco',
  description: 'Account con UID, accesso e Premium; Premium illimitato per email.',
};

export default function AccountManagementPage() {
  return <AccountManagementPanel />;
}
