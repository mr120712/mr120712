// @polsia:user-owned — sezione «Telegram» delle Impostazioni (/impostazioni), solo con l'accesso e
// se il bot è configurato (NEXT_PUBLIC_TELEGRAM_BOT_USERNAME). Collega l'account Solco al bot con un
// gate sicuro: un codice monouso a scadenza breve, generato lato server e legato al tuo userId. Il
// collegamento si completa SOLO dalla tua app Telegram (premendo Avvia nel bot). Mostra lo stato,
// permette di ricollegare e di scollegare.
'use client';

import { Check, Link2, Link2Off, Loader2, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/custom/app-ui/status-badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { TelegramLinkStartSchema, TelegramLinkStatusSchema } from '@/lib/contracts/telegram';

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

type Status = { linked: boolean; username: string | null };

export function TelegramAccountLink() {
  const { data: session, isPending } = useSession();
  const user = session?.user;

  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const alive = useRef(true);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const loadStatus = useCallback(async (): Promise<Status | null> => {
    try {
      const next = await apiFetch('/api/telegram/link', { schema: TelegramLinkStatusSchema });
      if (alive.current) setStatus(next);
      return next;
    } catch {
      if (alive.current) setStatus({ linked: false, username: null });
      return null;
    }
  }, []);

  // Carica lo stato una volta che c'è la sessione.
  useEffect(() => {
    if (user) void loadStatus();
  }, [user, loadStatus]);

  // Dopo aver aperto il bot, controlla qualche volta se il collegamento è arrivato.
  const pollForLink = useCallback(
    (attempt = 0) => {
      pollTimer.current = setTimeout(
        () => {
          void loadStatus().then((next) => {
            if (!alive.current) return;
            if (next?.linked) {
              setAwaiting(false);
              toast.success('Telegram collegato.');
              return;
            }
            if (attempt < 5) pollForLink(attempt + 1);
            else setAwaiting(false);
          });
        },
        attempt === 0 ? 2500 : 3500,
      );
    },
    [loadStatus],
  );

  if (!BOT_USERNAME || isPending || !user) return null;

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await apiFetch('/api/telegram/link', {
        method: 'POST',
        schema: TelegramLinkStartSchema,
      });
      window.open(url, '_blank', 'noopener,noreferrer');
      setAwaiting(true);
      pollForLink();
    } catch (error) {
      const cause =
        error instanceof Error && typeof error.cause === 'object' && error.cause !== null
          ? (error.cause as { error?: unknown })
          : null;
      toast.error(
        cause?.error === 'not_configured'
          ? 'Telegram non è disponibile in questo momento.'
          : 'Non riesco a generare il codice. Riprova.',
      );
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      const next = await apiFetch('/api/telegram/link', {
        method: 'DELETE',
        schema: TelegramLinkStatusSchema,
      });
      if (alive.current) setStatus(next);
      setAwaiting(false);
      toast.success('Telegram scollegato.');
    } catch {
      toast.error('Non riesco a scollegare adesso. Riprova.');
    } finally {
      setBusy(false);
    }
  };

  const linked = status?.linked === true;

  return (
    <section
      aria-labelledby="telegram-link-heading"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 text-card-foreground"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="telegram-link-heading" className="flex items-center gap-2 text-lg font-semibold">
          <Send aria-hidden="true" className="size-5 text-muted-foreground" />
          Telegram
        </h2>
        {status === null ? (
          <StatusBadge tone="neutral">…</StatusBadge>
        ) : linked ? (
          <StatusBadge tone="positive">Collegato</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Non collegato</StatusBadge>
        )}
      </div>

      {linked ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <Check aria-hidden="true" className="size-4 text-muted-foreground" />
              Account collegato al bot
            </span>
            {status?.username ? (
              <span className="break-all font-medium">@{status.username}</span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Dal bot ricevi il tuo codice di invito e i tuoi brani caricati. Puoi scollegarlo quando
            vuoi.
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void disconnect()}
              disabled={busy}
            >
              <Link2Off aria-hidden="true" />
              Scollega Telegram
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Collega il tuo account al bot Telegram di Solco per ricevere il codice di invito e i
            tuoi brani direttamente in chat.
          </p>
          <p className="text-xs text-muted-foreground">
            🔒 Collegamento sicuro: generiamo un <strong>codice monouso</strong> che scade in 15
            minuti. Solo tu, dalla tua app Telegram, puoi completarlo premendo{' '}
            <strong>Avvia</strong> nel bot.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => void connect()} disabled={busy || awaiting}>
              {awaiting ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Link2 aria-hidden="true" />
              )}
              {awaiting ? 'In attesa da Telegram…' : 'Collega account Telegram'}
            </Button>
            {awaiting ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void loadStatus()}
                disabled={busy}
              >
                Ho premuto Avvia
              </Button>
            ) : null}
          </div>
          {awaiting ? (
            <p className="text-xs text-muted-foreground">
              Apri il bot nella scheda aperta, premi <strong>Avvia</strong> e torna qui: lo stato si
              aggiorna da solo.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
