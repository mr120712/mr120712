// @polsia:user-owned — pannello /admin/app-ios: stato dell'IPA attivo, caricamento di un nuovo IPA
// (direttamente nello store privato Vercel Blob con un token di /api/admin/ios-app/blob, poi
// attivazione con POST /api/admin/ios-app, che lo ispeziona) e rimozione. Legge e scrive solo tramite
// le API admin; nessun file passa dal server di Solco durante il caricamento.
'use client';

import { upload } from '@vercel/blob/client';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  IOS_INSTALL_MESSAGES,
  type IosAdminStatus,
  IosAdminStatusSchema,
  IosIpaActivateResponseSchema,
  type IosIpaRecord,
} from '@/lib/contracts/ios-install';
import {
  IOS_ADMIN_BLOB_ENDPOINT,
  IOS_ADMIN_ENDPOINT,
  IOS_IPA_MAX_BYTES,
  iosIpaPathname,
} from '@/lib/ios-app';

/** Oltre questa dimensione il caricamento va a blocchi (più robusto su reti lente). */
const MULTIPART_FROM_BYTES = 8 * 1024 * 1024;

export const IOS_METHOD_LABELS: Record<IosIpaRecord['method'], string> = {
  'ad-hoc': 'Ad Hoc (dispositivi registrati)',
  development: 'Sviluppo (dispositivi registrati)',
  enterprise: 'Enterprise (tutti i dispositivi)',
  'app-store': 'App Store (non installabile da link)',
  unknown: 'firma non riconosciuta (non installabile da link)',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Il messaggio di un errore di apiFetch (corpo {message}) o di upload, in italiano quando c'è. */
export function iosAdminErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause as { message?: unknown; error?: unknown } | null | undefined;
    if (cause && typeof cause.message === 'string' && cause.message) return cause.message;
    if (/apiFetch .* \(413\)/.test(error.message)) return 'Il file è troppo grande.';
  }
  return 'Operazione non riuscita. Riprova tra poco.';
}

type Phase = 'idle' | 'uploading' | 'checking' | 'removing';

function submitLabel(phase: Phase, progress: number): string {
  if (phase === 'uploading') return `Caricamento… ${progress}%`;
  if (phase === 'checking') return 'Controllo dell’IPA…';
  return 'Carica e attiva';
}

export function IosAppPanel() {
  const [status, setStatus] = useState<IosAdminStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch(IOS_ADMIN_ENDPOINT, { schema: IosAdminStatusSchema }));
      setLoadError(null);
    } catch {
      setLoadError('Stato dell’app iOS non disponibile: ricarica la pagina.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || phase !== 'idle') return;
    if (file.size > IOS_IPA_MAX_BYTES) {
      toast.error(`L’IPA supera ${formatBytes(IOS_IPA_MAX_BYTES)}.`);
      return;
    }
    setPhase('uploading');
    setProgress(0);
    try {
      const staged = await upload(iosIpaPathname(status?.expectedVersion ?? 'app'), file, {
        access: 'private',
        handleUploadUrl: IOS_ADMIN_BLOB_ENDPOINT,
        contentType: 'application/octet-stream',
        multipart: file.size > MULTIPART_FROM_BYTES,
        onUploadProgress: ({ percentage }) => setProgress(Math.round(percentage)),
      });
      setPhase('checking');
      const result = await apiFetch(IOS_ADMIN_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({ blobUrl: staged.url, size: file.size }),
        schema: IosIpaActivateResponseSchema,
      });
      toast.success(
        `IPA ${result.current.version} attivo: ${IOS_METHOD_LABELS[result.current.method]}.`,
      );
      setFile(null);
      await load();
    } catch (error) {
      toast.error(iosAdminErrorMessage(error));
    } finally {
      setPhase('idle');
      setProgress(0);
    }
  }

  async function handleRemove() {
    if (phase !== 'idle') return;
    if (!window.confirm('Rimuovere l’IPA attivo? Il pulsante «Installa l’app» sparirà da /app.')) {
      return;
    }
    setPhase('removing');
    try {
      await apiFetch(IOS_ADMIN_ENDPOINT, { method: 'DELETE' });
      toast.success('IPA rimosso.');
      await load();
    } catch (error) {
      toast.error(iosAdminErrorMessage(error));
    } finally {
      setPhase('idle');
    }
  }

  const current = status?.current ?? null;
  const busy = phase !== 'idle';

  return (
    <div className="grid gap-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Spazio amministrativo</p>
        <h1 className="text-3xl font-semibold tracking-normal text-foreground">App iOS</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          L’IPA che il sito installa da /app sugli iPhone registrati. Il file resta nello store
          privato e si scarica solo con un link a scadenza rilasciato a chi ha un account.
        </p>
      </div>

      <section
        aria-labelledby="ios-status-heading"
        className="grid max-w-2xl gap-3 rounded-xl border border-border bg-card p-6"
      >
        <h2 id="ios-status-heading" className="font-semibold text-card-foreground">
          IPA attivo
        </h2>
        {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
        {status && !status.configured ? (
          <p className="text-sm text-destructive">{IOS_INSTALL_MESSAGES.notConfigured}</p>
        ) : null}
        {status?.configured && !current ? (
          <p className="text-sm text-muted-foreground">
            Nessun IPA attivo: in /app gli utenti vedono solo il profilo iOS.
          </p>
        ) : null}
        {current ? (
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Versione</dt>
            <dd>{current.version}</dd>
            <dt className="text-muted-foreground">Identificativo</dt>
            <dd>{current.bundleId}</dd>
            <dt className="text-muted-foreground">Firma</dt>
            <dd>
              {IOS_METHOD_LABELS[current.method]}
              {current.devices !== null ? ` · ${current.devices} dispositivi nel profilo` : ''}
            </dd>
            <dt className="text-muted-foreground">Caricato</dt>
            <dd>
              {formatDate(current.uploadedAt)} · {formatBytes(current.sizeBytes)}
            </dd>
          </dl>
        ) : null}
        {status ? (
          <p className="text-xs text-muted-foreground">
            Il sito accetta solo {status.expectedBundleId} versione {status.expectedVersion}{' '}
            (src/lib/android-app.ts); per una versione nuova aggiorna prima il codice.
          </p>
        ) : null}
        {current ? (
          <div>
            <Button type="button" variant="outline" disabled={busy} onClick={handleRemove}>
              {phase === 'removing' ? 'Rimozione…' : 'Rimuovi l’IPA'}
            </Button>
          </div>
        ) : null}
      </section>

      <form
        onSubmit={handleUpload}
        aria-labelledby="ios-upload-heading"
        className="grid max-w-2xl gap-3 rounded-xl border border-border bg-card p-6"
      >
        <h2 id="ios-upload-heading" className="font-semibold text-card-foreground">
          Carica un IPA firmato
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Serve l’artefatto del workflow «iOS (IPA)» in modalità <code>ipa-adhoc</code> (o un IPA
          esportato Ad Hoc da Xcode). Il server lo ispeziona prima di attivarlo: identificativo,
          versione e firma; un IPA senza firma o firmato per l’App Store viene rifiutato.
        </p>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">File .ipa</span>
          <input
            type="file"
            accept=".ipa,application/octet-stream,application/x-itunes-ipa"
            disabled={busy || status?.configured === false}
            onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
            className="block w-full cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-sm"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!file || busy || status?.configured === false}>
            {submitLabel(phase, progress)}
          </Button>
          {file ? (
            <span className="text-xs text-muted-foreground">
              {file.name} · {formatBytes(file.size)}
            </span>
          ) : null}
        </div>
      </form>

      <section className="grid max-w-2xl gap-2 rounded-xl border border-border bg-card p-6 text-sm leading-6 text-muted-foreground">
        <h2 className="font-semibold text-card-foreground">Come funziona per gli utenti</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Registri il loro iPhone (UDID) nell’account Apple Developer e rigeneri l’IPA Ad Hoc: il
            profilo incorporato elenca i dispositivi ammessi, fino a 100 l’anno.
          </li>
          <li>
            In /app, con l’account, toccano «Installa l’app» da Safari: il link vale 15 minuti ed è
            legato al loro account; iOS scarica manifest e file dal sito, mai dallo store.
          </li>
          <li>
            Un iPhone non registrato riceve da iOS «Impossibile installare»: non è un errore del
            sito.
          </li>
        </ol>
      </section>
    </div>
  );
}
