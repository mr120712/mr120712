// @polsia:user-owned
'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { SocialSignInButtons } from '@/components/custom/social-sign-in-buttons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signUp } from '@/lib/auth-client';
import {
  emailAuthErrorMessage,
  emailAuthNetworkErrorMessage,
  safeAuthDestination,
} from '@/lib/business/auth-form';

export function SignUpForm() {
  const router = useRouter();
  const [callbackURL, setCallbackURL] = useState('/dashboard');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setCallbackURL(
      safeAuthDestination(new URLSearchParams(window.location.search).get('callbackURL')),
    );
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const name = String(formData.get('name') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');

    try {
      const result = await signUp.email({ name, email, password, callbackURL });
      if (result.error) {
        setError(emailAuthErrorMessage(result.error, 'signup'));
        return;
      }

      router.replace(callbackURL);
      router.refresh();
    } catch {
      setError(emailAuthNetworkErrorMessage());
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-5">
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-2">
          <Label htmlFor="signup-name">Nome</Label>
          <Input
            id="signup-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            disabled={pending}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="signup-email">Email</Label>
          <Input
            id="signup-email"
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            disabled={pending}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="signup-password">Password</Label>
          <Input
            id="signup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            disabled={pending}
          />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Ti invieremo un link per verificare l’indirizzo email. Potrai entrare subito nel diario.
        </p>
        {error ? (
          <p className="text-sm leading-6 text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button className="h-11 w-full" type="submit" disabled={pending}>
          {pending ? 'Creazione account…' : 'Crea account'}
        </Button>
      </form>
      <SocialSignInButtons callbackURL={callbackURL} />
    </div>
  );
}
