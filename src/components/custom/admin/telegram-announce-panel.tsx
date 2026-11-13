// @polsia:user-owned — pannello /admin/telegram: anteprima dell'annuncio build e pubblicazione
// on-demand sul canale. Legge e scrive solo tramite /api/admin/telegram-announce.
'use client';

import { CircleCheck, CircleX, RotateCw, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { AppSurface } from '@/components/custom/app-ui/app-shell';
import { PageHeader } from '@/components/custom/app-ui/page-header';
import { Panel } from '@/components/custom/app-ui/panel';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  type AnnouncePreview,
  AnnouncePreviewSchema,
  AnnounceResultSchema,
} from '@/lib/contracts/telegram-announce';

const ENDPOINT = '/api/admin/telegram-announce';
const ERROR_TEXT_MAX = 300;

const ERROR_CODE_TEXT: Record<string, string> = {
  unauthorized: 'La sessione è scaduta: accedi di nuovo.',
  forbidden: 'Serve un account amministratore con email verificata.',
  forbidden_origin: 'Richiesta rifiutata per sicurezza: ricarica la pagina e riprova.',
  session_unavailable: 'Non riesco a verificare la sessione in questo momento. Riprova tra poco.',
};

const REASON_TEXT: Record<string, string> = {
  bot_not_configured:
    'Il bot Telegram non è configurato (manca TELEGRAM_BOT_TOKEN). Impostalo su Vercel e ridistribuisci.',
  channel_not_configured:
    'Il canale non è configurato (manca TELEGRAM_CHANNEL_CHAT_ID). Impostalo su Vercel e ridistribuisci.',
  telegram_failed:
    'Telegram ha rifiutato l’invio. Controlla che il bot sia amministratore del canale e che l’id sia corretto.',
};

function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof ZodError) return 'La risposta del server non è nel formato atteso.';
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete e riprova.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown; error?: unknown })
      : null;
  if (typeof cause?.message === 'string' && cause.message.trim()) {
    return cause.message.trim().slice(0, ERROR_TEXT_MAX);
  }
  const code = cause?.error;
  return typeof code === 'string' && Object.hasOwn(ERROR_CODE_TEXT, code)
    ? (ERROR_CODE_TEXT[code] ?? fallback)
    : fallback;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: AnnouncePreview };

export function TelegramAnnouncePanel() {
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const [publishing, setPublishing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const publishingRef = useRef(false);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setView({ kind: 'loading' });
    try {
      const data = await apiFetch(ENDPOINT, { schema: AnnouncePreviewSchema });
      if (request !== requestRef.current) return;
      setView({ kind: 'ready', data });
    } catch (error) {
      if (request !== requestRef.current) return;
      setView({
        kind: 'error',
        message: failureMessage(error, 'Non riesco a mostrare l’anteprima. Riprova.'),
      });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const publish = async () => {
    if (publishingRef.current) return;
    publishingRef.current = true;
    setPublishing(true);
    setAnnouncement('Pubblicazione in corso…');
    try {
      const result = await apiFetch(ENDPOINT, { method: 'POST', schema: AnnounceResultSchema });
      if (result.posted) {
        setAnnouncement('Annuncio pubblicato sul canale.');
        toast.success('Annuncio pubblicato sul canale Telegram.');
        setView((current) =>
          current.kind === 'ready'
            ? { kind: 'ready', data: { ...current.data, alreadyAnnounced: true } }
            : current,
        );
      } else {
        const message = REASON_TEXT[result.reason] ?? 'Pubblicazione non riuscita.';
        setAnnouncement(message);
        toast.error(message);
      }
    } catch (error) {
      const message = failureMessage(error, 'La pubblicazione non è riuscita. Riprova tra poco.');
      setAnnouncement(`Non pubblicato. ${message}`);
      toast.error(message);
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  };

  const ready = view.kind === 'ready' ? view.data : null;
  const configured = ready?.botConfigured === true && ready?.channelConfigured === true;

  return (
    <AppSurface className="bg-transparent">
      <PageHeader
        title="Annunci su Telegram"
        description="Pubblica sul canale un breve avviso con la riga di sintesi del commit e la versione. Nessun dato sensibile."
        actions={
          <Button
            type="button"
            onClick={() => void publish()}
            aria-disabled={publishing || !configured || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            <Send aria-hidden="true" />
            {publishing ? 'Pubblicazione…' : 'Pubblica l’annuncio ora'}
          </Button>
        }
      />
      <output aria-live="polite" className="block text-sm text-muted-foreground">
        {announcement}
      </output>

      {view.kind === 'loading' ? (
        <Skeleton className="h-40 w-full motion-reduce:animate-none" />
      ) : null}

      {view.kind === 'error' ? (
        <div role="alert" className="grid gap-3 rounded-xl border border-border bg-card p-6">
          <p className="font-semibold text-card-foreground">Non riesco a mostrare l’anteprima.</p>
          <p className="text-sm text-muted-foreground">{view.message}</p>
          <div>
            <Button type="button" variant="outline" onClick={() => void load()}>
              <RotateCw aria-hidden="true" />
              Riprova
            </Button>
          </div>
        </div>
      ) : null}

      {ready ? (
        <>
          <Panel title="Configurazione">
            <ul className="grid gap-2 text-sm">
              <li className="flex items-center gap-2">
                <ConfigMark ok={ready.botConfigured} />
                Bot Telegram{' '}
                {ready.botConfigured ? 'configurato' : 'non configurato (TELEGRAM_BOT_TOKEN)'}
              </li>
              <li className="flex items-center gap-2">
                <ConfigMark ok={ready.channelConfigured} />
                Canale{' '}
                {ready.channelConfigured
                  ? 'configurato'
                  : 'non configurato (TELEGRAM_CHANNEL_CHAT_ID)'}
              </li>
            </ul>
            {!configured ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Imposta le variabili mancanti su Vercel, rendi il bot amministratore del canale e
                ridistribuisci, poi torna qui.
              </p>
            ) : null}
          </Panel>

          <Panel
            title="Anteprima del messaggio"
            description={
              ready.alreadyAnnounced
                ? 'Questa build è già stata annunciata una volta. Puoi comunque ripubblicarla.'
                : 'Questo è il testo che verrà pubblicato sul canale.'
            }
          >
            <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-4 text-sm text-foreground">
              {ready.preview}
            </pre>
            {ready.commitShort ? (
              <p className="mt-2 text-sm text-muted-foreground">Versione: {ready.commitShort}</p>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                Nessuna versione rilevata (fuori da Vercel).
              </p>
            )}
          </Panel>
        </>
      ) : null}
    </AppSurface>
  );
}

function ConfigMark({ ok }: { ok: boolean }) {
  return ok ? (
    <CircleCheck aria-hidden="true" className="size-4 text-[var(--status-ok,currentColor)]" />
  ) : (
    <CircleX aria-hidden="true" className="size-4 text-destructive" />
  );
}
