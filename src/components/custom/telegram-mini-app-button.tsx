// @polsia:user-owned — "Apri su Telegram": link diretto che apre Solco come Mini App dentro
// Telegram. Compare solo se il bot è configurato (NEXT_PUBLIC_TELEGRAM_BOT_USERNAME). Richiede la
// "Main Mini App" attiva in @BotFather. Nessuna richiesta di rete: è un semplice link t.me.
'use client';

import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { telegramMiniAppLink } from '@/lib/telegram-mini-app';

export function TelegramMiniAppButton({
  startParam,
  label = 'Apri su Telegram',
  className,
}: {
  /** Parametro di avvio opzionale (arriva alla Mini App come start_param). */
  startParam?: string;
  label?: string;
  className?: string;
}) {
  const href = telegramMiniAppLink(startParam);
  if (!href) return null;
  return (
    // data-telegram-open: nascosto via CSS quando Solco è GIÀ aperta dentro Telegram (vedi
    // custom-style.css, html[data-telegram-mini-app]) — lì il pulsante sarebbe ridondante.
    <Button asChild variant="outline" className={className} data-telegram-open>
      <a href={href} target="_blank" rel="noopener noreferrer">
        <Send aria-hidden="true" />
        {label}
        <span className="sr-only"> (si apre in Telegram)</span>
      </a>
    </Button>
  );
}
