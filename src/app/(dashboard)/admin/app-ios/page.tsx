// @polsia:user-owned — pagina admin «App iOS»: l'IPA firmato Ad Hoc che il sito distribuisce da /app.
import type { Metadata } from 'next';
import { IosAppPanel } from '@/components/custom/admin/ios-app-panel';

export const metadata: Metadata = {
  title: 'App iOS — Amministrazione Solco',
  description: 'Carica, attiva o rimuovi l’IPA che il sito installa sugli iPhone registrati.',
};

export default function AdminIosAppPage() {
  return <IosAppPanel />;
}
