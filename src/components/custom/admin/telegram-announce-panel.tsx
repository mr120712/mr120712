// @polsia:user-owned — pannello /admin/telegram: anteprima dell'annuncio build e pubblicazione
// on-demand sul canale. Legge e scrive solo tramite /api/admin/telegram-announce.
'use client';

import { AppWindow, CircleCheck, CircleX, RotateCw, Send, Webhook } from 'lucide-react';
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
import {
  TelegramMenuSetResultSchema,
  type TelegramMenuStatus,
  TelegramMenuStatusSchema,
} from '@/lib/contracts/telegram-menu';
import {
  TelegramWebhookRegisterResultSchema,
  type TelegramWebhookStatus,
  TelegramWebhookStatusSchema,
} from '@/lib/contracts/telegram-webhook';

const ENDPOINT = '/api/admin/telegram-announce';
const WEBHOOK_ENDPOINT = '/api/admin/telegram-webhook';
const MENU_ENDPOINT = '/api/admin/telegram-menu';
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
  const [webhook, setWebhook] = useState<TelegramWebhookStatus | null>(null);
  const [registering, setRegistering] = useState(false);
  const [menu, setMenu] = useState<TelegramMenuStatus | null>(null);
  const [settingMenu, setSettingMenu] = useState(false);
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

  const loadWebhook = useCallback(async () => {
    try {
      const data = await apiFetch(WEBHOOK_ENDPOINT, { schema: TelegramWebhookStatusSchema });
      setWebhook(data);
    } catch {
      // Non blocca il pannello: se non riesco a leggere lo stato del webhook, lo nascondo.
    }
  }, []);

  const loadMenu = useCallback(async () => {
    try {
      const data = await apiFetch(MENU_ENDPOINT, { schema: TelegramMenuStatusSchema });
      setMenu(data);
    } catch {
      // Non blocca il pannello: se non riesco a leggere lo stato del pulsante, lo nascondo.
    }
  }, []);

  const registerWebhook = async () => {
    setRegistering(true);
    try {
      const result = await apiFetch(WEBHOOK_ENDPOINT, {
        method: 'POST',
        schema: TelegramWebhookRegisterResultSchema,
      });
      setWebhook(result.status);
      if (result.ok) toast.success('Webhook del bot registrato.');
      else toast.error(result.message);
    } catch (error) {
      toast.error(failureMessage(error, 'Registrazione del webhook non riuscita.'));
    } finally {
      setRegistering(false);
    }
  };

  const setMenuButton = async () => {
    setSettingMenu(true);
    try {
      const result = await apiFetch(MENU_ENDPOINT, {
        method: 'POST',
        schema: TelegramMenuSetResultSchema,
      });
      setMenu(result.status);
      if (result.ok) toast.success('Pulsante del bot impostato.');
      else toast.error(result.message);
    } catch (error) {
      toast.error(failureMessage(error, 'Impostazione del pulsante non riuscita.'));
    } finally {
      setSettingMenu(false);
    }
  };

  useEffect(() => {
    void load();
    void loadWebhook();
    void loadMenu();
    return () => {
      requestRef.current += 1;
    };
  }, [load, loadWebhook, loadMenu]);

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

      {webhook ? (
        <Panel
          title="Bot interattivo (codici invito)"
          description="Quando è attivo, chi tocca «Ricevi il codice su Telegram» apre il bot e riceve il proprio codice referral in chat."
        >
          <ul className="grid gap-2 text-sm">
            <li className="flex items-center gap-2">
              <ConfigMark ok={webhook.botConfigured} />
              Bot {webhook.botConfigured ? 'configurato' : 'non configurato (TELEGRAM_BOT_TOKEN)'}
            </li>
            <li className="flex items-center gap-2">
              <ConfigMark ok={webhook.secretConfigured} />
              Secret del webhook{' '}
              {webhook.secretConfigured ? 'impostato' : 'mancante (TELEGRAM_WEBHOOK_SECRET)'}
            </li>
            <li className="flex items-center gap-2">
              <ConfigMark ok={webhook.matches} />
              Webhook {webhook.matches ? 'registrato su Telegram' : 'non registrato'}
            </li>
          </ul>
          {webhook.lastError ? (
            <p className="mt-2 text-sm text-destructive">
              Ultimo errore da Telegram: {webhook.lastError}
            </p>
          ) : null}
          {!webhook.secretConfigured ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Aggiungi <code>TELEGRAM_WEBHOOK_SECRET</code> su Vercel (una stringa casuale) e
              ridistribuisci, poi premi «Attiva webhook».
            </p>
          ) : null}
          <div className="mt-4">
            <Button
              type="button"
              variant={webhook.ready ? 'outline' : 'default'}
              onClick={() => void registerWebhook()}
              aria-disabled={
                registering || !webhook.botConfigured || !webhook.secretConfigured || undefined
              }
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            >
              <Webhook aria-hidden="true" />
              {registering
                ? 'Registrazione…'
                : webhook.ready
                  ? 'Ri-registra webhook'
                  : 'Attiva webhook'}
            </Button>
          </div>
          <p className="mt-2 break-all text-xs text-muted-foreground">URL: {webhook.expectedUrl}</p>
        </Panel>
      ) : null}

      {menu ? (
        <Panel
          title="Pulsante nel bot (apre Solco)"
          description="Imposta il pulsante del menu del bot su una Mini App: chi apre il bot vede «Apri Solco» e tocca per aprire il sito dentro Telegram."
        >
          <ul className="grid gap-2 text-sm">
            <li className="flex items-center gap-2">
              <ConfigMark ok={menu.botConfigured} />
              Bot {menu.botConfigured ? 'configurato' : 'non configurato (TELEGRAM_BOT_TOKEN)'}
            </li>
            <li className="flex items-center gap-2">
              <ConfigMark ok={menu.matches} />
              Pulsante {menu.matches ? 'impostato su «Apri Solco»' : 'non ancora impostato'}
            </li>
          </ul>
          {menu.matches && menu.text ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Testo attuale del pulsante: «{menu.text}»
            </p>
          ) : null}
          {menu.lastError ? (
            <p className="mt-2 text-sm text-destructive">
              Ultimo errore da Telegram: {menu.lastError}
            </p>
          ) : null}
          <div className="mt-4">
            <Button
              type="button"
              variant={menu.matches ? 'outline' : 'default'}
              onClick={() => void setMenuButton()}
              aria-disabled={settingMenu || !menu.botConfigured || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            >
              <AppWindow aria-hidden="true" />
              {settingMenu
                ? 'Impostazione…'
                : menu.matches
                  ? 'Reimposta pulsante'
                  : 'Imposta pulsante nel bot'}
            </Button>
          </div>
          <p className="mt-2 break-all text-xs text-muted-foreground">Apre: {menu.expectedUrl}</p>
        </Panel>
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
