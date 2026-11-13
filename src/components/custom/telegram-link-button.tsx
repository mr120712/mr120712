// @polsia:user-owned — pulsante "Ricevi il codice su Telegram": collega l'account al bot e lo porta
// a ricevere il proprio codice di invito. Compare solo se il bot è configurato
// (NEXT_PUBLIC_TELEGRAM_BOT_USERNAME impostato).
'use client';

import { Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { TelegramLinkResponseSchema } from '@/lib/contracts/telegram';

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

export function TelegramLinkButton() {
  const [loading, setLoading] = useState(false);
  if (!BOT_USERNAME) return null;

  const connect = async () => {
    setLoading(true);
    try {
      const { token } = await apiFetch('/api/telegram/link', {
        method: 'POST',
        schema: TelegramLinkResponseSchema,
      });
      const url = `https://t.me/${encodeURIComponent(BOT_USERNAME)}?start=${encodeURIComponent(token)}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      const cause =
        error instanceof Error && typeof error.cause === 'object' && error.cause !== null
          ? (error.cause as { error?: unknown })
          : null;
      if (cause?.error === 'Unauthorized' || cause?.error === 'unauthorized') {
        toast.error('Accedi per collegare Telegram.');
      } else {
        toast.error('Telegram non è disponibile in questo momento.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button type="button" variant="outline" onClick={() => void connect()} disabled={loading}>
      <Send aria-hidden="true" />
      {loading ? 'Apro Telegram…' : 'Ricevi il codice su Telegram'}
    </Button>
  );
}
