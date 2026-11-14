// @polsia:user-owned — scelta della nuova password dal link ricevuto via email
// (/reimposta-password?token=…). Il token viene tolto subito dalla barra degli indirizzi (resta solo
// in memoria), così non finisce nella cronologia o in uno screenshot. Dopo il cambio tutte le
// sessioni aperte vengono chiuse (revokeSessionsOnPasswordReset): si rientra con la nuova password.
'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

const MIN_PASSWORD_LENGTH = 8;

type LinkState = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'ready'; token: string };

export function ResetPasswordForm() {
  const [link, setLink] = useState<LinkState>({ kind: 'loading' });
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Letto una sola volta: in sviluppo React esegue l'effetto due volte (StrictMode) e alla seconda
  // l'URL è già stato ripulito.
  const linkRef = useRef<LinkState | null>(null);

  useEffect(() => {
    if (!linkRef.current) {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      const failed = params.get('error');
      linkRef.current = token && !failed ? { kind: 'ready', token } : { kind: 'invalid' };
      // Via il token dall'URL visibile (resta solo nello stato del componente).
      window.history.replaceState(null, '', window.location.pathname);
    }
    setLink(linkRef.current);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (link.kind !== 'ready') return;
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') ?? '');
    const confirm = String(data.get('confirm') ?? '');
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`La password deve contenere almeno ${MIN_PASSWORD_LENGTH} caratteri.`);
      return;
    }
    if (password !== confirm) {
      setError('Le due password non coincidono.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { error: apiError } = await authClient.resetPassword({
        newPassword: password,
        token: link.token,
      });
      if (apiError) {
        const code = (apiError.code ?? '').toUpperCase();
        if (code.includes('INVALID_TOKEN')) {
          setLink({ kind: 'invalid' });
          return;
        }
        if (code.includes('PASSWORD_TOO_SHORT')) {
          setError(`La password deve contenere almeno ${MIN_PASSWORD_LENGTH} caratteri.`);
          return;
        }
        if (code.includes('PASSWORD_TOO_LONG')) {
          setError('La password è troppo lunga.');
          return;
        }
        setError('Non è stato possibile aggiornare la password. Riprova.');
        return;
      }
      setDone(true);
    } catch {
      setError('Connessione non riuscita. Controlla la rete e riprova.');
    } finally {
      setPending(false);
    }
  }

  if (link.kind === 'loading') {
    return <p className="text-sm text-muted-foreground">Verifica del link…</p>;
  }

  if (done) {
    return (
      <output className="grid gap-4">
        <p className="text-sm leading-6">
          Password aggiornata. Per sicurezza abbiamo chiuso tutte le sessioni aperte: accedi di
          nuovo con la nuova password.
        </p>
        <Button asChild className="h-11 w-full">
          <Link href="/login">Accedi</Link>
        </Button>
      </output>
    );
  }

  if (link.kind === 'invalid') {
    return (
      <div className="grid gap-4" role="alert">
        <p className="text-sm leading-6">
          Questo link non è valido o è scaduto (vale un’ora e si può usare una sola volta).
        </p>
        <Button asChild variant="outline" className="h-11 w-full">
          <Link href="/password-dimenticata">Chiedi un nuovo link</Link>
        </Button>
      </div>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={handleSubmit}>
      <div className="grid gap-2">
        <Label htmlFor="reset-password">Nuova password</Label>
        <Input
          id="reset-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
          disabled={pending}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reset-confirm">Ripeti la nuova password</Label>
        <Input
          id="reset-confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
          disabled={pending}
        />
      </div>
      {error ? (
        <p className="text-sm leading-6 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button className="h-11 w-full" type="submit" disabled={pending}>
        {pending ? 'Aggiornamento…' : 'Salva la nuova password'}
      </Button>
    </form>
  );
}
