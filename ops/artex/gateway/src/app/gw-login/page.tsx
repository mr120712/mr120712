'use client';

import { type FormEvent, useState } from 'react';

import { signIn } from '@/lib/auth-client';

type State =
  | { kind: 'idle' }
  | { kind: 'signing' }
  | { kind: 'error'; message: string };

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const u = username.trim();
    const p = password;
    if (!u || !p) return;
    setState({ kind: 'signing' });
    try {
      const { error } = await signIn.username({
        username: u,
        password: p,
      });
      if (error) {
        setState({ kind: 'error', message: error.message ?? 'Username or password not recognised.' });
        return;
      }
      window.location.href = '/';
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Username or password not recognised.',
      });
    }
  }

  return (
    <main>
      <h1>Sign in to ARTEX</h1>
      <p>Admin username and password.</p>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          type="text"
          name="username"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={state.kind === 'signing'}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={state.kind === 'signing'}
        />
        <button type="submit" disabled={state.kind === 'signing' || !username.trim() || !password}>
          {state.kind === 'signing' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {state.kind === 'error' ? <div className="notice error">{state.message}</div> : null}
    </main>
  );
}
