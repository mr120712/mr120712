// @polsia:user-owned — pagina del «Bot Solco»: un bot sul sito che cerca musica Creative Commons,
// radio e podcast e li riproduce nel player. 30 ricerche/mese per gli account free, illimitate per i
// Premium (il limite lo impone l'API /api/bot/command).
import type { Metadata } from 'next';
import { BotConsole } from '@/components/custom/music/bot-console';

export const metadata: Metadata = {
  // Titolo assoluto: il marchio è già nel nome («Bot Solco · Solco» lo ripeterebbe su Google).
  title: { absolute: 'Bot Solco' },
  description:
    'Chiedi al Bot Solco e trova brani Creative Commons, radio e podcast da ascoltare subito, anche in slowed / sped up. 30 ricerche gratis al mese.',
  // Pagina pubblica in sitemap: canonical esplicito come le altre (www, https).
  alternates: { canonical: '/bot' },
};

export default function BotPage() {
  return <BotConsole />;
}
