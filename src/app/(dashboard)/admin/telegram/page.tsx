// @polsia:user-owned
import type { Metadata } from 'next';
import { TelegramAnnouncePanel } from '@/components/custom/admin/telegram-announce-panel';

export const metadata: Metadata = {
  title: 'Annunci Telegram — Amministrazione Solco',
  description: 'Pubblica sul canale Telegram l’annuncio della build corrente.',
};

export default function TelegramAdminPage() {
  return <TelegramAnnouncePanel />;
}
