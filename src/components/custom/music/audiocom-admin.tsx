// @polsia:user-owned — pagina admin «audio.com»: collega l'account audio.com usato dal server per
// aggiungere i brani di audio.com alla ricerca di Solco, ne mostra lo stato e permette di
// scollegarlo.
//
// Come funziona: audio.com ammette solo OAuth con PKCE e un account vero, quindi un amministratore
// collega UNA volta un account audio.com (meglio uno dedicato a Solco). Il server registra Solco
// presso audio.com in automatico (registrazione dinamica, nessun segreto da configurare), conserva
// i token cifrati e li rinnova da solo. Tutti gli ascoltatori cercano con quel collegamento, con un
// limite globale di 40 ricerche al minuto (audio.com ne ammette 60 per account). I brani si
// riproducono in Solco solo con licenza CC0 / CC BY / CC BY-SA / CC BY-ND; gli altri si ascoltano
// solo nel player ufficiale di audio.com.
// Prima di collegare va verificato che i termini dell'API di audio.com consentano questo uso.
// Con l'account collegato, il pannello «Carica su audio.com» pubblica un file dal dispositivo
// dell'amministratore sul suo account (audiocom-upload-admin.tsx) e il pannello «In evidenza nella
// Home» sceglie le collection dell'account da mostrare in Home come sezioni
// (audiocom-featured-admin.tsx).
'use client';

import { AlertTriangle, CheckCircle2, Link2, Unlink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { AppSurface } from '@/components/custom/app-ui/app-shell';
import { PageHeader } from '@/components/custom/app-ui/page-header';
import { Panel } from '@/components/custom/app-ui/panel';
import { AudioComFeaturedAdmin } from '@/components/custom/music/audiocom-featured-admin';
import { AudioComUploadAdmin } from '@/components/custom/music/audiocom-upload-admin';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  type AudioComConnectionStatus,
  AudioComConnectionStatusSchema,
  type AudioComErrorCode,
} from '@/lib/contracts/audiocom';

const STATUS_ENDPOINT = '/api/admin/audiocom';
const LOGIN_HREF = '/api/admin/audiocom/login';

/** Esito del ritorno da audio.com (?audiocom=connected | error&reason=…). */
const RETURN_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Account audio.com collegato.' },
  expired: { ok: false, text: 'Il collegamento è scaduto prima di finire: riprova.' },
  invalid_state: { ok: false, text: 'Collegamento non valido: riprova.' },
  session: {
    ok: false,
    text: 'Sessione non valida: accedi di nuovo come amministratore e riprova.',
  },
  denied: { ok: false, text: 'Hai annullato l’autorizzazione su audio.com.' },
  rate_limited: { ok: false, text: 'Troppi tentativi: riprova tra qualche minuto.' },
  registration: {
    ok: false,
    text: 'audio.com non ha accettato la registrazione di Solco: riprova più tardi.',
  },
  failed: { ok: false, text: 'Collegamento ad audio.com non riuscito.' },
};

export const AUDIOCOM_ERROR_TEXT: Record<AudioComErrorCode, string> = {
  reauth_required: 'audio.com non accetta più il collegamento: ricollega l’account.',
  refresh_failed: 'Il rinnovo automatico dell’accesso non è riuscito (riprova da solo).',
  search_unauthorized: 'audio.com ha rifiutato una ricerca: l’accesso viene rinnovato da solo.',
  rate_limited: 'audio.com ha segnalato troppe richieste: la ricerca riprende da sola.',
  search_failed: 'Una ricerca su audio.com non è riuscita.',
  invalid_response: 'audio.com ha risposto in un formato inatteso.',
};

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Rome',
  }).format(date);
}

function apiError(error: unknown): string {
  if (error instanceof ZodError) return 'Risposta del server non valida.';
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown; error?: unknown })
      : null;
  if (typeof cause?.message === 'string' && cause.message.trim()) return cause.message.trim();
  if (cause?.error === 'forbidden' || cause?.error === 'unauthorized') {
    return 'Serve un account amministratore con email verificata.';
  }
  return 'Operazione non riuscita. Riprova.';
}

export function AudioComAdmin() {
  const [status, setStatus] = useState<AudioComConnectionStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await apiFetch(STATUS_ENDPOINT, { schema: AudioComConnectionStatusSchema }));
      setLoadError(null);
    } catch (error) {
      setLoadError(apiError(error));
    }
  }, []);

  // Stato all'avvio + messaggio del ritorno da audio.com, poi l'indirizzo torna pulito.
  useEffect(() => {
    void loadStatus();
    try {
      const params = new URLSearchParams(window.location.search);
      const outcome = params.get('audiocom');
      if (outcome) {
        const key = outcome === 'connected' ? 'connected' : params.get('reason') || 'failed';
        const message = RETURN_MESSAGES[key] ?? RETURN_MESSAGES.failed;
        if (message) (message.ok ? toast.success : toast.error)(message.text);
        params.delete('audiocom');
        params.delete('reason');
        const query = params.toString();
        window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
      }
    } catch {
      // window/history non disponibili: niente messaggio.
    }
  }, [loadStatus]);

  const disconnect = async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await apiFetch(STATUS_ENDPOINT, { method: 'DELETE' });
      toast.success('audio.com scollegato: la ricerca continua senza i suoi brani.');
      await loadStatus();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <AppSurface className="bg-transparent">
      <PageHeader
        title="audio.com"
        description="Brani di audio.com nella ricerca e nella Home di Solco, con licenza e attribuzione."
      />

      <Panel
        title="Collega audio.com"
        description="Un solo account audio.com serve le ricerche di tutti gli ascoltatori."
      >
        <StatusBody
          status={status}
          loadError={loadError}
          disconnecting={disconnecting}
          onDisconnect={() => void disconnect()}
          onRetry={() => void loadStatus()}
        />
      </Panel>

      {/* Con l'account collegato: caricamento di un brano e collection da mostrare in Home. */}
      {status?.connected ? (
        <>
          <AudioComUploadAdmin />
          <AudioComFeaturedAdmin />
        </>
      ) : null}

      <Panel title="Come funziona" description="Da leggere prima di collegare.">
        <ul className="grid list-disc gap-2 pl-5 text-sm leading-6 text-muted-foreground">
          <li>
            Verifica prima che i termini d’uso dell’API di audio.com consentano questo uso: ricerca
            per tutti gli utenti di un servizio commerciale, con un unico account, link ai brani e
            player ufficiale incorporato. Meglio un account audio.com dedicato a Solco.
          </li>
          <li>
            «Collega audio.com» registra Solco presso audio.com (automatico, nessun segreto da
            impostare) e ti porta alla pagina di autorizzazione di audio.com (permesso “public”). I
            token restano cifrati sul server e si rinnovano da soli.
          </li>
          <li>
            Le ricerche passano da questo account con un limite globale di 40 al minuto (audio.com
            ne ammette 60) e una cache di 10 minuti: oltre il limite audio.com salta e le altre
            fonti rispondono come sempre.
          </li>
          <li>
            Solco riproduce nel proprio player solo i brani con licenza CC0, CC BY, CC BY-SA o CC
            BY-ND, sempre con autore, licenza e link al brano. Tutti gli altri (tutti i diritti
            riservati, nessuna licenza, licenze non commerciali) si ascoltano solo nel player
            ufficiale di audio.com.
          </li>
          <li>
            «Carica su audio.com»: pubblica sul tuo account un file dal dispositivo (fino a 100 MB),
            solo musica tua o di cui hai i diritti. Il file passa dallo storage di Solco e da lì si
            cancella appena audio.com lo ha ricevuto (o se l’invio non riesce).
          </li>
          <li>
            «In evidenza nella Home»: scegli fino a 6 collection (album o playlist) del tuo account;
            la Home le mostra come sezioni con le stesse regole di licenza della ricerca e si
            aggiorna da sola ogni 10 minuti.
          </li>
          <li>
            «Scollega» cancella i token: i brani di audio.com spariscono dalla ricerca e dalla Home.
          </li>
        </ul>
      </Panel>
    </AppSurface>
  );
}

function StatusBody({
  status,
  loadError,
  disconnecting,
  onDisconnect,
  onRetry,
}: {
  status: AudioComConnectionStatus | null;
  loadError: string | null;
  disconnecting: boolean;
  onDisconnect: () => void;
  onRetry: () => void;
}) {
  if (!status) {
    return loadError ? (
      <div className="grid gap-2 text-sm">
        <p className="text-destructive">{loadError}</p>
        <div>
          <Button type="button" variant="outline" onClick={onRetry}>
            Riprova
          </Button>
        </div>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground">Caricamento dello stato…</p>
    );
  }

  if (!status.configured) {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        Il collegamento non è attivo: servono su Vercel <code>NEXT_PUBLIC_APP_URL</code> con
        l’indirizzo https di Solco e <code>BETTER_AUTH_SECRET</code> (da qui deriva la chiave che
        cifra i token). Non serve nessuna chiave di audio.com.
      </p>
    );
  }

  const connectedAt = formatDate(status.connectedAt);
  const lastErrorAt = formatDate(status.lastErrorAt);
  const errorText = status.lastError ? AUDIOCOM_ERROR_TEXT[status.lastError] : null;

  return (
    <div className="grid gap-3 text-sm">
      {status.connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <CheckCircle2 aria-hidden="true" className="size-4 text-primary" />
          <span className="text-foreground">
            Collegato{status.accountName ? ` come ${status.accountName}` : ''}
            {connectedAt ? ` dal ${connectedAt}` : ''}.
          </span>
          <Button
            type="button"
            variant="outline"
            className="h-8 gap-1.5 px-2 text-xs aria-disabled:opacity-60"
            onClick={onDisconnect}
            aria-disabled={disconnecting || undefined}
          >
            <Unlink aria-hidden="true" />
            {disconnecting ? 'Scollego…' : 'Scollega'}
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <p className="text-muted-foreground">
            {status.needsReconnect
              ? 'Il collegamento non vale più: ricollega l’account audio.com.'
              : 'Nessun account audio.com collegato: la ricerca non mostra i brani di audio.com.'}
          </p>
          <div>
            <Button asChild>
              <a href={LOGIN_HREF}>
                <Link2 aria-hidden="true" />
                {status.needsReconnect ? 'Ricollega audio.com' : 'Collega audio.com'}
              </a>
            </Button>
          </div>
        </div>
      )}

      {errorText ? (
        <p className="flex items-start gap-2 text-muted-foreground">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            Ultimo problema{lastErrorAt ? ` (${lastErrorAt})` : ''}: {errorText}
          </span>
        </p>
      ) : null}

      {status.redirectUri ? (
        <p className="text-xs text-muted-foreground">
          Indirizzo di ritorno registrato presso audio.com:{' '}
          <code className="break-all">{status.redirectUri}</code>
          {status.clientRegistered ? '' : ' (la registrazione avviene al primo collegamento)'}
        </p>
      ) : null}
    </div>
  );
}
