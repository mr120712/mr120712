'use client';

import { type FormEvent, useState } from 'react';

import { signIn } from '@/lib/auth-client';

type Mode = 'passkey' | 'pin' | 'bootstrap';

type PasskeyState = { kind: 'idle' } | { kind: 'authenticating' } | { kind: 'error'; message: string };
type PinState = { kind: 'idle' } | { kind: 'signing' } | { kind: 'error'; message: string };
type BootstrapState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('passkey');

  const [passkeyState, setPasskeyState] = useState<PasskeyState>({ kind: 'idle' });
  const [pinEmail, setPinEmail] = useState('');
  const [pin, setPin] = useState('');
  const [pinState, setPinState] = useState<PinState>({ kind: 'idle' });
  const [bootstrapEmail, setBootstrapEmail] = useState('');
  const [bootstrapState, setBootstrapState] = useState<BootstrapState>({ kind: 'idle' });

  async function onPasskey() {
    setPasskeyState({ kind: 'authenticating' });
    try {
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

  async function onPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = pinEmail.trim();
    const trimmedPin = pin.trim();
    if (!trimmedEmail || !trimmedPin) return;
    setPinState({ kind: 'signing' });
    try {
      const { error } = await signIn.email({
        email: trimmedEmail,
        password: trimmedPin,
        callbackURL: '/',
      });
      if (error) {
        setPinState({ kind: 'error', message: error.message ?? 'Email or PIN not recognised.' });
        return;
      }
      window.location.href = '/';
    } catch (err) {
      setPinState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Email or PIN not recognised.',
      });
    }
  }

  async function onBootstrap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = bootstrapEmail.trim();
    if (!trimmed) return;
    setBootstrapState({ kind: 'sending' });
    try {
      const { error } = await signIn.magicLink({ email: trimmed, callbackURL: '/enroll' });
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

      <div
        role="tablist"
        aria-label="Sign-in method"
        style={{ display: 'flex', gap: 8, marginBottom: 20, fontSize: 13 }}
      >
        {([
          ['passkey', 'Passkey'],
          ['pin', 'PIN'],
          ['bootstrap', 'Bootstrap'],
        ] as [Mode, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            style={{
              background: mode === key ? '#262626' : 'transparent',
              color: mode === key ? '#fafafa' : '#a3a3a3',
              padding: '6px 12px',
              fontSize: 13,
              border: '1px solid #262626',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'passkey' ? (
        <>
          <p>Use the passkey registered on this device (FaceID, TouchID, Windows Hello, YubiKey).</p>
          <button
            type="button"
            onClick={onPasskey}
            disabled={passkeyState.kind === 'authenticating'}
          >
            {passkeyState.kind === 'authenticating' ? 'Waiting for authenticator…' : 'Sign in with passkey'}
          </button>
          {passkeyState.kind === 'error' ? (
            <div className="notice error">{passkeyState.message}</div>
          ) : null}
        </>
      ) : null}

      {mode === 'pin' ? (
        <>
          <p>
            Enter the admin email and the numeric PIN set in the gateway's env. Useful when the
            device has no passkey yet.
          </p>
          <form onSubmit={onPin} noValidate>
            <label htmlFor="pin-email">Email</label>
            <input
              id="pin-email"
              type="email"
              name="email"
              autoComplete="username"
              required
              value={pinEmail}
              onChange={(e) => setPinEmail(e.target.value)}
              disabled={pinState.kind === 'signing'}
            />
            <label htmlFor="pin-input">PIN</label>
            <input
              id="pin-input"
              type="password"
              name="pin"
              inputMode="numeric"
              autoComplete="current-password"
              required
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={pinState.kind === 'signing'}
            />
            <button
              type="submit"
              disabled={pinState.kind === 'signing' || !pinEmail.trim() || !pin.trim()}
            >
              {pinState.kind === 'signing' ? 'Signing in…' : 'Sign in with PIN'}
            </button>
          </form>
          {pinState.kind === 'error' ? (
            <div className="notice error">{pinState.message}</div>
          ) : null}
        </>
      ) : null}

      {mode === 'bootstrap' ? (
        <>
          <p>
            The gateway prints a one-time sign-in URL to its server logs (not email). An operator
            with shell access reads it with <code>docker compose logs gateway</code>, opens the
            URL, and registers a passkey on this device.
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
              gateway's container logs on the VPS.
            </div>
          ) : null}
          {bootstrapState.kind === 'error' ? (
            <div className="notice error">{bootstrapState.message}</div>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
