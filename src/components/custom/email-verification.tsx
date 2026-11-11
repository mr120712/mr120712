// @polsia:user-owned
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

export function EmailVerification({
  email,
  callbackURL = '/profile',
}: {
  email: string;
  callbackURL?: string;
}) {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);

  async function resend() {
    setPending(true);
    setSent(false);
    setFailed(false);
    try {
      const result = await authClient.sendVerificationEmail({ email, callbackURL });
      if (result.error) setFailed(true);
      else setSent(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Verifica il tuo indirizzo email</h2>
      <p className="text-sm text-muted-foreground">
        Conferma {email} dal link ricevuto. Se non trovi l’email, puoi richiederne un altro qui
        sotto.
      </p>
      {sent ? (
        <output>Controlla la posta: ti abbiamo inviato un nuovo link di verifica.</output>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          Non è stato possibile inviare l’email di verifica. Riprova tra poco.
        </p>
      ) : null}
      <Button type="button" onClick={resend} disabled={pending}>
        {pending ? 'Invio…' : 'Invia di nuovo il link di verifica'}
      </Button>
    </div>
  );
}
