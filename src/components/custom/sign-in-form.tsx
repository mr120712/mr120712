// @polsia:user-owned
'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { SocialSignInButtons } from '@/components/custom/social-sign-in-buttons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signIn } from '@/lib/auth-client';
import {
  emailAuthErrorMessage,
  emailAuthNetworkErrorMessage,
  safeAuthDestination,
} from '@/lib/business/auth-form';

export function SignInForm() {
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
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');

    try {
      const result = await signIn.email({ email, password, callbackURL });
      if (result.error) {
        setError(emailAuthErrorMessage(result.error, 'login'));
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
          <Label htmlFor="login-email">Email</Label>
          <Input
            id="login-email"
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
          <Label htmlFor="login-password">Password</Label>
          <Input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
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
          {pending ? 'Accesso in corso…' : 'Accedi'}
        </Button>
      </form>
      <SocialSignInButtons callbackURL={callbackURL} />
    </div>
  );
}
