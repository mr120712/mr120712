// @polsia:user-owned — "Password dimenticata": chiede il link via email. La risposta è SEMPRE la
// stessa (anche per email non iscritte): così il modulo non rivela chi ha un account Solco.
'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

/** Dove porta il link dell'email (percorso interno: lo accetta il controllo dei redirect). */
export const RESET_PASSWORD_PATH = '/reimposta-password';

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    if (!email) return;
    setPending(true);
    setError(null);
    try {
      const { error: apiError } = await authClient.requestPasswordReset({
        email,
        redirectTo: RESET_PASSWORD_PATH,
      });
      if (apiError && (apiError.status === 429 || apiError.status === 503)) {
        setError(
          apiError.message?.trim() ||
            'Hai fatto troppe richieste. Attendi qualche minuto e riprova.',
        );
        return;
      }
      if (apiError && apiError.status === 400 && /email/i.test(apiError.message ?? '')) {
        setError('Inserisci un indirizzo email valido.');
        return;
      }
      // Qualsiasi altro esito: messaggio neutro (non si rivela se l'email è iscritta).
      setSent(true);
    } catch {
      setError('Connessione non riuscita. Controlla la rete e riprova.');
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <output className="grid gap-4">
        <p className="text-sm leading-6">
          Se esiste un account Solco con questa email, ti abbiamo inviato un link per scegliere una
          nuova password. Il link vale <strong>un’ora</strong>. Controlla anche la cartella spam.
        </p>
        <Button asChild variant="outline" className="h-11 w-full">
          <Link href="/login">Torna all’accesso</Link>
        </Button>
      </output>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={handleSubmit}>
      <div className="grid gap-2">
        <Label htmlFor="forgot-email">Email del tuo account</Label>
        <Input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
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
        {pending ? 'Invio in corso…' : 'Inviami il link'}
      </Button>
    </form>
  );
}
