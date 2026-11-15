// @polsia:user-owned — «Gestione account» (/admin/account): due pannelli.
// - «Premium illimitato»: concede il Premium senza scadenza a un'email (anche prima che l'account
//   esista: si attiva al primo accesso, es. con Google) e mostra ogni concessione con il suo stato
//   (attiva, in attesa del primo accesso, email non verificata, revocata) e l'UID dell'account; un
//   tocco revoca o riattiva.
// - «Account»: l'elenco degli account (25 per pagina, i più recenti prima) con UID (copiabile),
//   accesso (Google, email, telefono), email verificata, ruolo, blocco e fonti del Premium attive;
//   ricerca per nome, email o UID.
// Dati da /api/admin/premium-grants e /api/admin/accounts con i loro contratti; esiti delle azioni
// con un toast, errori del modulo accanto al campo.
'use client';

import { Copy, Crown, RefreshCw, Search, ShieldCheck, UserCog } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { AppSurface } from '@/components/custom/app-ui/app-shell';
import { PageHeader } from '@/components/custom/app-ui/page-header';
import { Panel } from '@/components/custom/app-ui/panel';
import { StatusBadge } from '@/components/custom/app-ui/status-badge';
import { PremiumBadge } from '@/components/custom/premium-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import { isPhoneAccountEmail } from '@/lib/business/phone-auth';
import { requestErrorMessage } from '@/lib/business/request-error-message';
import {
  type AccountProvider,
  ADMIN_ACCOUNT_QUERY_MAX,
  type AdminAccount,
  type AdminAccountsResponse,
  AdminAccountsResponseSchema,
  PREMIUM_GRANT_NOTE_MAX,
  type PremiumGrant,
  PremiumGrantResponseSchema,
  type PremiumGrantStatus,
  PremiumGrantsResponseSchema,
} from '@/lib/contracts/account-admin';
import type { AdminPremiumSource } from '@/lib/contracts/admin-signups';
import styles from './account-management.module.css';

const GRANTS_PATH = '/api/admin/premium-grants';
const ACCOUNTS_PATH = '/api/admin/accounts';

const DATE = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'Europe/Rome',
});

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : DATE.format(date);
}

const STATUS_TEXT: Record<
  PremiumGrantStatus,
  { label: string; tone: 'positive' | 'info' | 'warning' | 'neutral'; hint: string }
> = {
  active: {
    label: 'Attivo',
    tone: 'positive',
    hint: 'L’account con questa email verificata ha il Premium illimitato.',
  },
  pending: {
    label: 'In attesa del primo accesso',
    tone: 'info',
    hint: 'Nessun account con questa email: si attiva al primo accesso (per esempio con Google).',
  },
  unverified: {
    label: 'Email non verificata',
    tone: 'warning',
    hint: 'L’account esiste ma l’email non è verificata: si attiva dopo la conferma o con l’accesso con Google.',
  },
  revoked: { label: 'Revocato', tone: 'neutral', hint: 'Nessun Premium da questa concessione.' },
};

const SOURCE_LABEL: Record<AdminPremiumSource, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
  inApp: 'App Store',
  solcoPro: 'Solco Pro',
  rewards: 'Premi',
  unlimited: 'Illimitato',
};

const PROVIDER_LABEL: Record<AccountProvider, string> = {
  google: 'Google',
  email: 'Email e password',
  phone: 'Telefono',
  other: 'Altro accesso',
};

/** Gli errori di campo che manda la rotta con lo stato 400 ({ errors: { email: … } }). */
function fieldErrors(error: unknown): Record<string, string> {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const errors = (cause as { errors?: unknown } | null)?.errors;
  if (!errors || typeof errors !== 'object') return {};
  return Object.fromEntries(
    Object.entries(errors as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

async function copyUid(uid: string) {
  try {
    await navigator.clipboard.writeText(uid);
    toast.success(`UID ${uid} copiato.`);
  } catch {
    toast.error('Non riesco a copiare: seleziona l’UID e copialo a mano.');
  }
}

function UidChip({ uid }: { uid: string | null }) {
  if (!uid) return <span className={styles.muted}>UID non ancora assegnato</span>;
  return (
    <span className={styles.uid}>
      <code>{uid}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={styles.copy}
        onClick={() => void copyUid(uid)}
        aria-label={`Copia l’UID ${uid}`}
        title="Copia l’UID"
      >
        <Copy aria-hidden="true" />
      </Button>
    </span>
  );
}

// ─── Premium illimitato ─────────────────────────────────────────────────────────────────────────

function GrantRow({
  grant,
  busy,
  onRevoke,
  onRestore,
}: {
  grant: PremiumGrant;
  busy: boolean;
  onRevoke: (grant: PremiumGrant) => void;
  onRestore: (grant: PremiumGrant) => void;
}) {
  const status = STATUS_TEXT[grant.status];
  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <p className={styles.email}>{grant.email}</p>
        <div className={styles.badges}>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          {grant.seeded ? <StatusBadge tone="info">Predefinito</StatusBadge> : null}
        </div>
        <p className={styles.muted}>{status.hint}</p>
        {grant.account ? (
          <p className={styles.meta}>
            Account: <strong>{grant.account.name || 'senza nome'}</strong> ·{' '}
            <UidChip uid={grant.account.uid} />
          </p>
        ) : null}
        {grant.note ? <p className={styles.meta}>Nota: {grant.note}</p> : null}
        <p className={styles.meta}>
          Concesso il {formatDate(grant.createdAt)}
          {grant.revokedAt ? ` · revocato il ${formatDate(grant.revokedAt)}` : ''}
        </p>
      </div>
      <div className={styles.rowActions}>
        {grant.status === 'revoked' ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => onRestore(grant)}>
            Riattiva
          </Button>
        ) : (
          <Button type="button" variant="outline" disabled={busy} onClick={() => onRevoke(grant)}>
            Revoca
          </Button>
        )}
      </div>
    </li>
  );
}

function PremiumGrantsPanel() {
  const emailId = useId();
  const noteId = useId();
  const errorId = useId();
  const [grants, setGrants] = useState<PremiumGrant[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await apiFetch(GRANTS_PATH, { schema: PremiumGrantsResponseSchema });
      setGrants(result.items);
    } catch (error) {
      setLoadError(
        requestErrorMessage(error, 'Non riesco a caricare le concessioni. Riprova tra poco.'),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (grant: PremiumGrant) =>
    setGrants((current) => {
      const list = current ?? [];
      const rest = list.filter((item) => item.id !== grant.id);
      return list.some((item) => item.id === grant.id)
        ? list.map((item) => (item.id === grant.id ? grant : item))
        : [grant, ...rest];
    });

  async function grantTo(target: string, withNote?: string) {
    const result = await apiFetch(GRANTS_PATH, {
      method: 'POST',
      body: JSON.stringify(
        withNote === undefined ? { email: target } : { email: target, note: withNote },
      ),
      schema: PremiumGrantResponseSchema,
    });
    replace(result.grant);
    return result.grant;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setBusy('form');
    try {
      const grant = await grantTo(email, note.trim() ? note : undefined);
      toast.success(`Premium illimitato concesso a ${grant.email}.`);
      setEmail('');
      setNote('');
    } catch (error) {
      const fields = fieldErrors(error);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else
        toast.error(
          requestErrorMessage(error, 'Non è stato possibile concedere il Premium. Riprova.'),
        );
    } finally {
      setBusy(null);
    }
  }

  async function revoke(grant: PremiumGrant) {
    setBusy(grant.id);
    try {
      const result = await apiFetch(`${GRANTS_PATH}?id=${encodeURIComponent(grant.id)}`, {
        method: 'DELETE',
        schema: PremiumGrantResponseSchema,
      });
      replace(result.grant);
      toast.success(`Premium illimitato revocato per ${grant.email}.`);
    } catch (error) {
      toast.error(requestErrorMessage(error, 'Non è stato possibile revocarlo. Riprova.'));
    } finally {
      setBusy(null);
    }
  }

  async function restore(grant: PremiumGrant) {
    setBusy(grant.id);
    try {
      await grantTo(grant.email);
      toast.success(`Premium illimitato riattivato per ${grant.email}.`);
    } catch (error) {
      toast.error(requestErrorMessage(error, 'Non è stato possibile riattivarlo. Riprova.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="Premium illimitato"
      description="Premium senza scadenza per un’email: vale solo per l’account con quell’email verificata (per esempio con l’accesso Google), anche se l’account nasce dopo."
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.field}>
          <label htmlFor={emailId}>Email</label>
          <Input
            id={emailId}
            type="email"
            inputMode="email"
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? errorId : undefined}
            placeholder="nome@esempio.it"
          />
          {errors.email ? (
            <p id={errorId} className={styles.error}>
              {errors.email}
            </p>
          ) : null}
        </div>
        <div className={styles.field}>
          <label htmlFor={noteId}>Nota (facoltativa)</label>
          <Input
            id={noteId}
            value={note}
            maxLength={PREMIUM_GRANT_NOTE_MAX}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Perché lo concedi"
          />
          {errors.note ? <p className={styles.error}>{errors.note}</p> : null}
        </div>
        <Button type="submit" disabled={busy !== null || !email.trim()} className={styles.submit}>
          <Crown aria-hidden="true" />
          {busy === 'form' ? 'Concessione…' : 'Concedi Premium illimitato'}
        </Button>
      </form>

      {loadError ? (
        <div className={styles.state} role="alert">
          <p>{loadError}</p>
          <Button type="button" variant="outline" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" /> Riprova
          </Button>
        </div>
      ) : grants === null ? (
        <output className={styles.skeletons}>
          <span className="sr-only">Caricamento delle concessioni…</span>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </output>
      ) : grants.length === 0 ? (
        <p className={styles.muted}>Nessuna concessione per ora.</p>
      ) : (
        <ul className={styles.list} aria-label="Concessioni del Premium illimitato">
          {grants.map((grant) => (
            <GrantRow
              key={grant.id}
              grant={grant}
              busy={busy !== null}
              onRevoke={(item) => void revoke(item)}
              onRestore={(item) => void restore(item)}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ─── Account ────────────────────────────────────────────────────────────────────────────────────

/**
 * Come mostrare l'account: per quelli creati col numero di telefono l'email è solo un segnaposto
 * interno (…@telefono.solcomusic.invalid), quindi si mostra il numero.
 */
function accountContact(account: AdminAccount): { label: string; phone: boolean } {
  if (!isPhoneAccountEmail(account.email)) return { label: account.email, phone: false };
  const digits = account.email.split('@')[0] ?? '';
  return { label: digits ? `Telefono +${digits}` : 'Account con telefono', phone: true };
}

function AccountRow({ account }: { account: AdminAccount }) {
  const contact = accountContact(account);
  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <p className={styles.name}>
          {account.name || 'Senza nome'}
          {account.role === 'admin' ? (
            <ShieldCheck aria-label="Amministratore" className={styles.adminIcon} />
          ) : null}
        </p>
        <p className={styles.email}>{contact.label}</p>
        <p className={styles.meta}>
          <UidChip uid={account.uid} />
        </p>
        <div className={styles.badges}>
          {account.premium.length > 0 ? (
            <PremiumBadge
              size="sm"
              detail={account.premium.map((source) => SOURCE_LABEL[source]).join(', ')}
            />
          ) : (
            <StatusBadge>Free</StatusBadge>
          )}
          {account.role === 'admin' ? <StatusBadge tone="info">Amministratore</StatusBadge> : null}
          {contact.phone ? null : account.emailVerified ? (
            <StatusBadge tone="positive">Email verificata</StatusBadge>
          ) : (
            <StatusBadge tone="warning">Email non verificata</StatusBadge>
          )}
          {account.banned ? <StatusBadge tone="critical">Bloccato</StatusBadge> : null}
        </div>
        <p className={styles.meta}>
          Accesso:{' '}
          {account.providers.length > 0
            ? account.providers.map((provider) => PROVIDER_LABEL[provider]).join(', ')
            : 'nessun metodo collegato'}{' '}
          · iscritto il {formatDate(account.createdAt)}
        </p>
      </div>
    </li>
  );
}

function AccountsPanel() {
  const searchId = useId();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<AdminAccountsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt è il trigger di «Riprova».
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ q: query, page: String(page) });
    apiFetch(`${ACCOUNTS_PATH}?${params.toString()}`, { schema: AdminAccountsResponseSchema })
      .then((result) => {
        if (active) setData(result);
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(
            requestErrorMessage(failure, 'Non riesco a caricare gli account. Riprova tra poco.'),
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query, page, attempt]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(0);
    setQuery(draft.trim());
  }

  return (
    <Panel
      title="Account"
      description="Calcolato dai dati salvati: il Premium segue le stesse regole delle statistiche «Iscritti»."
    >
      <form className={styles.search} onSubmit={search}>
        <label htmlFor={searchId} className="sr-only">
          Cerca per nome, email o UID
        </label>
        <Input
          id={searchId}
          type="search"
          value={draft}
          maxLength={ADMIN_ACCOUNT_QUERY_MAX}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Nome, email o UID (es. SOL-7K2M-9QXD)"
        />
        <Button type="submit" variant="outline">
          <Search aria-hidden="true" /> Cerca
        </Button>
      </form>

      {error ? (
        <div className={styles.state} role="alert">
          <p>{error}</p>
          <Button type="button" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw aria-hidden="true" /> Riprova
          </Button>
        </div>
      ) : loading && !data ? (
        <output className={styles.skeletons}>
          <span className="sr-only">Caricamento degli account…</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </output>
      ) : data && data.items.length > 0 ? (
        <>
          <p className={styles.muted} aria-live="polite">
            {data.total === 1 ? '1 account' : `${data.total} account`}
            {query ? ` per «${query}»` : ''}
          </p>
          <ul className={styles.list} aria-label="Account" aria-busy={loading || undefined}>
            {data.items.map((account) => (
              <AccountRow key={account.id} account={account} />
            ))}
          </ul>
          {data.page > 0 || data.hasMore ? (
            <div className={styles.pager}>
              <Button
                type="button"
                variant="outline"
                disabled={data.page === 0 || loading}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                Precedenti
              </Button>
              <span className={styles.muted}>Pagina {data.page + 1}</span>
              <Button
                type="button"
                variant="outline"
                disabled={!data.hasMore || loading}
                onClick={() => setPage((value) => value + 1)}
              >
                Successivi
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className={styles.muted}>
          {query ? `Nessun account per «${query}».` : 'Nessun account per ora.'}
        </p>
      )}
    </Panel>
  );
}

export function AccountManagementPanel() {
  return (
    <AppSurface>
      <PageHeader
        title="Gestione account"
        description={
          <span className={styles.headerNote}>
            <UserCog aria-hidden="true" /> Ogni account ha un UID leggibile (SOL-…) da usare per
            l’assistenza e nel database.
          </span>
        }
      />
      <div className={styles.panels}>
        <PremiumGrantsPanel />
        <AccountsPanel />
      </div>
    </AppSurface>
  );
}
