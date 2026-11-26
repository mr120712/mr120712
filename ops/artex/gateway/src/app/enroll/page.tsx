'use client';

import { useState } from 'react';

import { passkey, useSession } from '@/lib/auth-client';

type State =
  | { kind: 'idle' }
  | { kind: 'registering' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export default function EnrollPage() {
  const session = useSession();
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function onRegister() {
    setState({ kind: 'registering' });
    try {
      // Browser prompts for a new passkey (FaceID / TouchID / Windows Hello / YubiKey).
      // Better Auth stores the public key against the current user.
      const result = await passkey.addPasskey({
        name: `ARTEX gateway — ${new Date().toISOString().slice(0, 10)}`,
      });
      if (result?.error) {
        setState({
          kind: 'error',
          message: result.error.message ?? 'Could not register the passkey.',
        });
        return;
      }
      setState({ kind: 'done' });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not register the passkey.',
      });
    }
  }

  if (session.isPending) {
    return (
      <main>
        <h1>Loading…</h1>
      </main>
    );
  }

  if (!session.data?.user) {
    return (
      <main>
        <h1>Not signed in</h1>
        <p>
          The bootstrap link has expired or has not been used yet. Go back to{' '}
          <a href="/login" style={{ color: '#60a5fa' }}>
            /login
          </a>{' '}
          and request a new bootstrap URL from the server logs.
        </p>
      </main>
    );
  }

  if (state.kind === 'done') {
    return (
      <main>
        <h1>Passkey registered</h1>
        <p>
          You can now sign out and sign back in with the passkey on this device. Future logins
          need no email, no password, no server logs — just the authenticator.
        </p>
        <button type="button" onClick={() => (window.location.href = '/')}>Continue to ARTEX</button>
      </main>
    );
  }

  return (
    <main>
      <h1>Register a passkey</h1>
      <p>
        Signed in as <strong>{session.data.user.email}</strong>. Register a passkey on this
        device so you can sign in without the bootstrap link next time.
      </p>
      <button type="button" onClick={onRegister} disabled={state.kind === 'registering'}>
        {state.kind === 'registering' ? 'Waiting for authenticator…' : 'Register passkey'}
      </button>
      {state.kind === 'error' ? <div className="notice error">{state.message}</div> : null}
    </main>
  );
}
