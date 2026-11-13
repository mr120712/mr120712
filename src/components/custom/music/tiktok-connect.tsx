// @polsia:user-owned — collega l'account TikTok di Solco (Login Kit) e pubblica un video annunciato
// (Content Posting, Direct Post con URL del video). Solo pannello admin. TikTok richiede che la
// privacy sia scelta a mano (nessun default) e che il dominio del video sia verificato nel portale.
'use client';

import { CheckCircle2, Link2, Loader2, Send, Unlink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  TIKTOK_CAPTION_MAX,
  TIKTOK_PRIVACY_LABELS,
  type TikTokConnectionStatus,
  TikTokConnectionStatusSchema,
  type TikTokCreatorInfo,
  TikTokCreatorInfoSchema,
  type TikTokPrivacyLevel,
  TikTokPublishResultSchema,
  TikTokPublishStatusSchema,
} from '@/lib/contracts/tiktok-connect';
import styles from './discover.module.css';

const CONNECT_ENDPOINT = '/api/admin/tiktok/connect';
const PUBLISH_ENDPOINT = '/api/admin/tiktok/publish';
const LOGIN_HREF = '/api/admin/tiktok/connect/login';

const RETURN_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Account TikTok collegato.' },
  expired: { ok: false, text: 'Sessione del collegamento scaduta: riprova.' },
  invalid_state: { ok: false, text: 'Collegamento non valido: riprova.' },
  session: { ok: false, text: 'Sessione non valida: accedi di nuovo e riprova.' },
  denied: { ok: false, text: 'Hai annullato il collegamento a TikTok.' },
  scope: { ok: false, text: 'Permessi non concessi: riprova e concedi la pubblicazione.' },
  rate_limited: { ok: false, text: 'Troppi tentativi: riprova tra poco.' },
  failed: { ok: false, text: 'Collegamento a TikTok non riuscito.' },
};

function apiError(error: unknown): string {
  if (error instanceof ZodError) return 'Risposta del server non valida.';
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown; errors?: Record<string, unknown> })
      : null;
  if (typeof cause?.message === 'string' && cause.message.trim()) return cause.message.trim();
  const first = cause?.errors
    ? Object.values(cause.errors).find((v) => typeof v === 'string')
    : null;
  return typeof first === 'string' ? first : 'Operazione non riuscita. Riprova.';
}

export function TikTokConnect() {
  const [status, setStatus] = useState<TikTokConnectionStatus | null>(null);
  const [creator, setCreator] = useState<TikTokCreatorInfo | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [privacyLevel, setPrivacyLevel] = useState('');
  const [publishId, setPublishId] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await apiFetch(CONNECT_ENDPOINT, { schema: TikTokConnectionStatusSchema }));
    } catch {
      setStatus(null);
    }
  }, []);

  const loadCreator = useCallback(async () => {
    try {
      setCreator(await apiFetch(PUBLISH_ENDPOINT, { schema: TikTokCreatorInfoSchema }));
    } catch (error) {
      setCreator(null);
      toast.error(apiError(error));
    }
  }, []);

  // Stato all'avvio + messaggio di ritorno da TikTok (?tiktok=connected|error&reason=...).
  useEffect(() => {
    void loadStatus();
    try {
      const params = new URLSearchParams(window.location.search);
      const outcome = params.get('tiktok');
      if (outcome) {
        const key = outcome === 'connected' ? 'connected' : params.get('reason') || 'failed';
        const message = RETURN_MESSAGES[key] ?? RETURN_MESSAGES.failed;
        if (message) (message.ok ? toast.success : toast.error)(message.text);
        params.delete('tiktok');
        params.delete('reason');
        const query = params.toString();
        window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
      }
    } catch {
      // window/history not available: ignore.
    }
  }, [loadStatus]);

  // Quando è collegato, carica le opzioni di privacy del creator (obbligatorie prima di pubblicare).
  useEffect(() => {
    if (status?.configured && status.state === 'connected') void loadCreator();
  }, [status, loadCreator]);

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await apiFetch(CONNECT_ENDPOINT, { method: 'DELETE' });
      setCreator(null);
      setPrivacyLevel('');
      toast.success('Account TikTok scollegato.');
      await loadStatus();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setDisconnecting(false);
    }
  };

  const publish = async () => {
    if (publishing) return;
    setPublishing(true);
    setPublishId('');
    try {
      const result = await apiFetch(PUBLISH_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({
          videoUrl: videoUrl.trim(),
          caption: caption.trim(),
          privacyLevel,
        }),
        schema: TikTokPublishResultSchema,
      });
      setPublishId(result.publishId);
      toast.success('Pubblicazione avviata su TikTok.');
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setPublishing(false);
    }
  };

  const checkStatus = async () => {
    if (!publishId) return;
    try {
      const data = await apiFetch(
        `${PUBLISH_ENDPOINT}/status?publishId=${encodeURIComponent(publishId)}`,
        { schema: TikTokPublishStatusSchema },
      );
      if (data.status === 'PUBLISH_COMPLETE') toast.success('Video pubblicato su TikTok.');
      else if (data.failReason) toast.error(`TikTok: ${data.status} (${data.failReason})`);
      else toast(`Stato TikTok: ${data.status}`);
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  if (!status) {
    return (
      <section className={styles.aiPanel} aria-label="Collegamento a TikTok">
        <p className={styles.state}>Caricamento del collegamento a TikTok…</p>
      </section>
    );
  }

  if (!status.configured) {
    const redirectUri =
      typeof window !== 'undefined'
        ? `${window.location.origin}/api/admin/tiktok/connect/callback`
        : '/api/admin/tiktok/connect/callback';
    return (
      <section className={styles.aiPanel} aria-label="Collegamento a TikTok">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Link2 aria-hidden="true" className="size-4 text-primary" />
          Collega TikTok (per pubblicare)
        </p>
        <p className={styles.state}>
          Per pubblicare su TikTok crea un’app su TikTok for Developers, poi imposta su Vercel{' '}
          <code>TIKTOK_CLIENT_KEY</code> e <code>TIKTOK_CLIENT_SECRET</code> e registra come
          redirect URI: <code className="break-all">{redirectUri}</code>. Servono gli scope{' '}
          <code>user.info.basic</code> e <code>video.publish</code>.
        </p>
      </section>
    );
  }

  const connected = status.state === 'connected';
  const needsReconnect = status.state === 'outdated' || status.state === 'expired';
  const canPublish = connected && Boolean(videoUrl.trim() && caption.trim() && privacyLevel);

  return (
    <section className={styles.aiPanel} aria-label="Collegamento a TikTok">
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Link2 aria-hidden="true" className="size-4 text-primary" />
        Collega TikTok e pubblica
      </p>

      {connected ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <CheckCircle2
            aria-hidden="true"
            className="size-4 text-[var(--status-ok,currentColor)]"
          />
          <span className="text-foreground">
            Collegato{creator?.nickname ? ` come ${creator.nickname}` : ''}.
          </span>
          <Button
            type="button"
            variant="outline"
            className="h-8 gap-1.5 px-2 text-xs"
            onClick={() => void disconnect()}
            aria-disabled={disconnecting || undefined}
          >
            <Unlink aria-hidden="true" />
            Disconnetti
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <p className={styles.state}>
            {needsReconnect
              ? 'Il collegamento è scaduto o manca un permesso: ricollega l’account.'
              : 'Nessun account TikTok collegato.'}
          </p>
          <div>
            <Button asChild>
              <a href={LOGIN_HREF}>
                <Link2 aria-hidden="true" />
                {needsReconnect ? 'Ricollega TikTok' : 'Collega TikTok'}
              </a>
            </Button>
          </div>
        </div>
      )}

      {connected ? (
        <div className={styles.aiForm}>
          <label className={styles.state} htmlFor="tiktok-video-url">
            URL del video (https pubblico, su un dominio verificato nel portale TikTok)
          </label>
          <input
            id="tiktok-video-url"
            value={videoUrl}
            maxLength={2048}
            inputMode="url"
            placeholder="https://cdn.tuodominio.it/annunci/video.mp4"
            onChange={(event) => setVideoUrl(event.target.value)}
            className="min-h-10 rounded-lg border border-input bg-background px-3 text-sm"
          />
          <label className={styles.state} htmlFor="tiktok-caption">
            Didascalia (incolla quella generata dall’IA, con gli hashtag)
          </label>
          <textarea
            id="tiktok-caption"
            value={caption}
            maxLength={TIKTOK_CAPTION_MAX}
            rows={3}
            onChange={(event) => setCaption(event.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
          <label className={styles.state} htmlFor="tiktok-privacy">
            Chi può vedere il video (scegli tu: TikTok non imposta un valore predefinito)
          </label>
          <select
            id="tiktok-privacy"
            value={privacyLevel}
            onChange={(event) => setPrivacyLevel(event.target.value)}
            className="min-h-10 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="" disabled>
              Scegli la privacy…
            </option>
            {(creator?.privacyLevelOptions ?? []).map((level) => (
              <option key={level} value={level}>
                {TIKTOK_PRIVACY_LABELS[level as TikTokPrivacyLevel] ?? level}
              </option>
            ))}
          </select>
          <div className={styles.headerActions}>
            <Button
              type="button"
              onClick={() => void publish()}
              aria-disabled={publishing || !canPublish || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            >
              {publishing ? (
                <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Send aria-hidden="true" />
              )}
              {publishing ? 'Pubblicazione…' : 'Pubblica su TikTok'}
            </Button>
            {publishId ? (
              <Button type="button" variant="outline" onClick={() => void checkStatus()}>
                Controlla stato
              </Button>
            ) : null}
          </div>
          {publishId ? (
            <p className={styles.state}>
              Pubblicazione avviata. Il video appare su TikTok dopo l’elaborazione; «Controlla
              stato» per sapere quando è pronto.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
