// @polsia:user-owned — accesso/registrazione col numero di telefono: numero → codice SMS → dentro.
// Il codice lo invia e lo verifica Twilio (via better-auth, plugin phoneNumber). Al primo accesso
// con un numero nuovo l'account viene creato. Le chiamate passano da authClient.$fetch perché
// auth-client.ts è del framework (niente plugin client da aggiungere lì).
'use client';

import { Smartphone } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';
import { navigateTo } from '@/lib/browser-navigation';
import { safeAuthDestination } from '@/lib/business/auth-form';
import { maskPhoneNumber, normalizePhoneNumber } from '@/lib/business/phone-auth';

const RESEND_SECONDS = 60;

type FetchError = { status?: number; message?: string; code?: string } | null | undefined;

/** Messaggio in italiano per un errore delle API del telefono. */
export function phoneAuthErrorMessage(error: FetchError, step: 'send' | 'verify'): string {
  const status = error?.status ?? 0;
  const code = (error?.code ?? '').toUpperCase();
  if (status === 429) {
    return (
      error?.message?.trim() || 'Hai fatto troppi tentativi. Attendi qualche minuto e riprova.'
    );
  }
  if (status === 404) return 'L’accesso col telefono non è disponibile in questo momento.';
  if (code === 'SMS_NOT_SENT') {
    return (
      error?.message?.trim() ||
      'Non è stato possibile inviare l’SMS a questo numero. Controlla il numero o riprova più tardi.'
    );
  }
  if (step === 'verify' && (code.includes('OTP') || status === 400 || status === 403)) {
    return 'Codice non corretto o scaduto. Controlla l’SMS o chiedine uno nuovo.';
  }
  if (status === 400) {
    return 'Numero non valido: usa il formato internazionale, es. +39 333 123 4567.';
  }
  if (status >= 500) return 'Il servizio non è disponibile al momento. Riprova tra poco.';
  return step === 'send'
    ? 'Non è stato possibile inviare il codice. Riprova.'
    : 'Non è stato possibile verificare il codice. Riprova.';
}

export function PhoneSignIn({ mode }: { mode: 'login' | 'signup' }) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [countryCode, setCountryCode] = useState('+39');
  const [number, setNumber] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [callbackURL, setCallbackURL] = useState('/dashboard');
  /** Esito dell'ultimo invio: con 'limited' nessun SMS nuovo è partito (vale l'ultimo ricevuto). */
  const [lastSend, setLastSend] = useState<'sent' | 'limited'>('sent');
  const numberRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCallbackURL(
      safeAuthDestination(new URLSearchParams(window.location.search).get('callbackURL')),
    );
  }, []);

  // Il fuoco segue il passo: il campo del numero all'apertura (e con "Cambia numero"), il campo del
  // codice dopo l'invio. Senza, chi usa tastiera o lettore di schermo resterebbe sul <body>.
  useEffect(() => {
    if (!open) return;
    (step === 'code' ? codeRef : numberRef).current?.focus();
  }, [open, step]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  /**
   * 'sent' = SMS partito; 'limited' = troppe richieste (un codice già ricevuto resta valido: lo si
   * può ancora inserire, anche se qualcun altro ha chiesto codici per questo numero); 'failed'.
   */
  async function sendCode(target: string): Promise<'sent' | 'limited' | 'failed'> {
    setPending(true);
    setError(null);
    try {
      const { error: apiError } = await authClient.$fetch('/phone-number/send-otp', {
        method: 'POST',
        body: { phoneNumber: target },
      });
      if (apiError) {
        const limited = (apiError as FetchError)?.status === 429;
        setError(
          limited
            ? `${phoneAuthErrorMessage(apiError, 'send')} Se hai già ricevuto un codice via SMS, puoi inserirlo qui.`
            : phoneAuthErrorMessage(apiError, 'send'),
        );
        if (limited) {
          setResendIn(RESEND_SECONDS);
          setLastSend('limited');
        }
        return limited ? 'limited' : 'failed';
      }
      setResendIn(RESEND_SECONDS);
      setLastSend('sent');
      return 'sent';
    } catch {
      setError('Connessione non riuscita. Controlla la rete e riprova.');
      return 'failed';
    } finally {
      setPending(false);
    }
  }

  async function handlePhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizePhoneNumber(number, countryCode);
    if (!normalized) {
      setError('Numero non valido: controlla prefisso e numero (es. +39 333 123 4567).');
      return;
    }
    if ((await sendCode(normalized)) !== 'failed') {
      setPhone(normalized);
      setCode('');
      setStep('code');
    }
  }

  async function handleCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!phone) return;
    const digits = code.replace(/\D/g, '');
    if (digits.length < 4) {
      setError('Inserisci il codice ricevuto via SMS.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { error: apiError } = await authClient.$fetch('/phone-number/verify', {
        method: 'POST',
        body: { phoneNumber: phone, code: digits },
      });
      if (apiError) {
        setError(phoneAuthErrorMessage(apiError, 'verify'));
        return;
      }
      // Navigazione completa: la nuova sessione (cookie) viene letta da tutta l'app.
      navigateTo(callbackURL);
    } catch {
      setError('Connessione non riuscita. Controlla la rete e riprova.');
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" className="h-11 w-full" onClick={() => setOpen(true)}>
        <Smartphone aria-hidden="true" />
        {mode === 'login'
          ? 'Accedi con il numero di telefono'
          : 'Registrati con il numero di telefono'}
      </Button>
    );
  }

  return (
    <section className="grid gap-4 rounded-lg border border-border p-4">
      {step === 'phone' ? (
        <form className="grid gap-4" onSubmit={handlePhone}>
          <p className="text-sm text-muted-foreground">
            Ti inviamo un SMS con un codice. Il numero serve solo per accedere e non è mai mostrato
            agli altri.
          </p>
          <div className="grid grid-cols-[5.5rem_1fr] gap-2">
            <div className="grid gap-2">
              <Label htmlFor={`${ids}-cc`}>Prefisso</Label>
              <Input
                id={`${ids}-cc`}
                value={countryCode}
                onChange={(event) => setCountryCode(event.target.value)}
                inputMode="tel"
                autoComplete="tel-country-code"
                maxLength={5}
                disabled={pending}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${ids}-num`}>Numero di cellulare</Label>
              <Input
                ref={numberRef}
                id={`${ids}-num`}
                value={number}
                onChange={(event) => setNumber(event.target.value)}
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="333 123 4567"
                required
                disabled={pending}
              />
            </div>
          </div>
          {error ? (
            <p className="text-sm leading-6 text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button className="h-11 w-full" type="submit" disabled={pending}>
            {pending ? 'Invio del codice…' : 'Invia il codice via SMS'}
          </Button>
        </form>
      ) : (
        <form className="grid gap-4" onSubmit={handleCode}>
          <p id={`${ids}-code-help`} className="text-sm text-muted-foreground">
            {lastSend === 'sent' ? 'Abbiamo inviato un codice a' : 'Inserisci il codice ricevuto a'}{' '}
            <strong>{phone ? maskPhoneNumber(phone) : ''}</strong>. Vale 10 minuti.
          </p>
          <div className="grid gap-2">
            <Label htmlFor={`${ids}-code`}>Codice SMS</Label>
            <Input
              ref={codeRef}
              id={`${ids}-code`}
              aria-describedby={`${ids}-code-help`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={10}
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
            {pending ? 'Verifica…' : mode === 'login' ? 'Accedi' : 'Crea l’account'}
          </Button>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                setStep('phone');
                setError(null);
              }}
              disabled={pending}
            >
              Cambia numero
            </button>
            <button
              type="button"
              className="underline underline-offset-2 disabled:no-underline disabled:opacity-60"
              onClick={() => (phone ? void sendCode(phone) : undefined)}
              disabled={pending || resendIn > 0}
            >
              {resendIn > 0 ? `Invia di nuovo tra ${resendIn} s` : 'Invia di nuovo'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
