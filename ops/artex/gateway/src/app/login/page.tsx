'use client';

import { type FormEvent, useState } from 'react';

import { signIn } from '@/lib/auth-client';

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setState({ kind: 'sending' });
    try {
      // Better Auth signs in with a magic link. callbackURL is where the user
      // lands AFTER clicking the email link (the gateway middleware will then
      // forward authenticated traffic to ARTEX).
      const { error } = await signIn.magicLink({
        email: trimmed,
        callbackURL: '/',
      });
      if (error) {
        setState({ kind: 'error', message: error.message ?? 'Could not send the sign-in link.' });
        return;
      }
      setState({ kind: 'sent' });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not send the sign-in link.',
      });
    }
  }

  return (
    <main>
      <h1>Sign in to ARTEX</h1>
      <p>
        Enter your email. If the address is allowed, a one-time sign-in link lands in your inbox
        within a few seconds. The link expires in 10 minutes.
      </p>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          name="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={state.kind === 'sending' || state.kind === 'sent'}
        />
        <button type="submit" disabled={state.kind === 'sending' || state.kind === 'sent' || !email.trim()}>
          {state.kind === 'sending' ? 'Sending…' : 'Send sign-in link'}
        </button>
      </form>

      {state.kind === 'sent' ? (
        <div className="notice">
          Check your inbox. If an account exists for this address, a sign-in link is on its way.
        </div>
      ) : null}
      {state.kind === 'error' ? <div className="notice error">{state.message}</div> : null}
    </main>
  );
}
