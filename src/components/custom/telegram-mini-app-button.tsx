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
    <Button asChild variant="outline" className={className}>
      <a href={href} target="_blank" rel="noopener noreferrer">
        <Send aria-hidden="true" />
        {label}
        <span className="sr-only"> (si apre in Telegram)</span>
      </a>
    </Button>
  );
}
