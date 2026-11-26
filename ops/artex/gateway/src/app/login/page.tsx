'use client';

import { type FormEvent, useState } from 'react';

import { signIn } from '@/lib/auth-client';

type PasskeyState =
  | { kind: 'idle' }
  | { kind: 'authenticating' }
  | { kind: 'error'; message: string };

type BootstrapState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

export default function LoginPage() {
  const [passkeyState, setPasskeyState] = useState<PasskeyState>({ kind: 'idle' });
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [bootstrapEmail, setBootstrapEmail] = useState('');
  const [bootstrapState, setBootstrapState] = useState<BootstrapState>({ kind: 'idle' });

  async function onPasskey() {
    setPasskeyState({ kind: 'authenticating' });
    try {
      // Better Auth will prompt the browser's WebAuthn chooser; on success
      // it sets the session cookie and the server replies with 200. We just
      // redirect to '/', which the middleware then forwards to ARTEX.
      const { error } = await signIn.passkey();
      if (error) {
        setPasskeyState({
          kind: 'error',
          message: error.message ?? 'Could not sign in with passkey.',
        });
        return;
      }
      window.location.href = '/';
    } catch (err) {
      setPasskeyState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not sign in with passkey.',
      });
    }
  }

  async function onBootstrap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = bootstrapEmail.trim();
    if (!trimmed) return;
    setBootstrapState({ kind: 'sending' });
    try {
      const { error } = await signIn.magicLink({
        email: trimmed,
        callbackURL: '/enroll',
      });
      if (error) {
        setBootstrapState({
          kind: 'error',
          message: error.message ?? 'Could not generate the bootstrap link.',
        });
        return;
      }
      setBootstrapState({ kind: 'sent' });
    } catch (err) {
      setBootstrapState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not generate the bootstrap link.',
      });
    }
  }

  return (
    <main>
      <h1>Sign in to ARTEX</h1>
      <p>Use the passkey registered on this device.</p>

      <button type="button" onClick={onPasskey} disabled={passkeyState.kind === 'authenticating'}>
        {passkeyState.kind === 'authenticating' ? 'Waiting for authenticator…' : 'Sign in with passkey'}
      </button>

      {passkeyState.kind === 'error' ? (
        <div className="notice error">{passkeyState.message}</div>
      ) : null}

      <div style={{ marginTop: 32, borderTop: '1px solid #262626', paddingTop: 20 }}>
        <button
          type="button"
          onClick={() => setShowBootstrap((v) => !v)}
          style={{ background: 'transparent', color: '#a3a3a3', padding: 0, fontSize: 13 }}
        >
          {showBootstrap ? 'Hide bootstrap' : 'First time? Set up a passkey →'}
        </button>

        {showBootstrap ? (
          <>
            <p style={{ marginTop: 12, fontSize: 13 }}>
              The gateway will print a one-time sign-in URL to its server logs (not email).
              An operator with shell access to the VPS can read it with{' '}
              <code>docker compose logs gateway</code>, click the URL, and register a passkey
              for this device.
            </p>
            <form onSubmit={onBootstrap} noValidate>
              <label htmlFor="bootstrap-email">Admin email</label>
              <input
                id="bootstrap-email"
                type="email"
                name="email"
                autoComplete="email"
                required
                value={bootstrapEmail}
                onChange={(e) => setBootstrapEmail(e.target.value)}
                disabled={bootstrapState.kind === 'sending' || bootstrapState.kind === 'sent'}
              />
              <button
                type="submit"
                disabled={
                  bootstrapState.kind === 'sending' ||
                  bootstrapState.kind === 'sent' ||
                  !bootstrapEmail.trim()
                }
              >
                {bootstrapState.kind === 'sending' ? 'Generating…' : 'Print bootstrap URL to logs'}
              </button>
            </form>
            {bootstrapState.kind === 'sent' ? (
              <div className="notice">
                Request accepted. If this address is the admin, the one-time URL is now in the
                gateway's container logs. Run <code>docker compose logs gateway --tail=50</code>{' '}
                on the VPS to read it.
              </div>
            ) : null}
            {bootstrapState.kind === 'error' ? (
              <div className="notice error">{bootstrapState.message}</div>
            ) : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
