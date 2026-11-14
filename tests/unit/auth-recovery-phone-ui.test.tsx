// @polsia:user-owned
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    $fetch: mocks.fetch,
    requestPasswordReset: mocks.requestPasswordReset,
    resetPassword: mocks.resetPassword,
  },
}));
vi.mock('@/lib/browser-navigation', () => ({ navigateTo: mocks.navigate }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { ForgotPasswordForm } from '@/components/custom/forgot-password-form';
import { PhoneSignIn, phoneAuthErrorMessage } from '@/components/custom/phone-sign-in';
import { ResetPasswordForm } from '@/components/custom/reset-password-form';

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount(node: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
}

function setInput(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error('input non trovato');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(container: HTMLElement) {
  const form = container.querySelector('form');
  if (!form) throw new Error('form non trovato');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function button(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  if (!found) throw new Error(`pulsante "${text}" non trovato`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/login');
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('accesso col telefono', () => {
  it('numero → codice SMS → dentro (con il redirect richiesto)', async () => {
    window.history.replaceState(null, '', '/login?callbackURL=%2Fpremi');
    mocks.fetch.mockResolvedValue({ data: { status: true }, error: null });
    const c = await mount(<PhoneSignIn mode="login" />);

    await act(async () => button(c, 'Accedi con il numero di telefono').click());
    setInput(c.querySelector('input[type="tel"]'), '333 123 4567');
    await submit(c);
    expect(mocks.fetch).toHaveBeenCalledWith('/phone-number/send-otp', {
      method: 'POST',
      body: { phoneNumber: '+393331234567' },
    });
    // Il numero è mostrato mascherato, mai per intero.
    expect(c.textContent).toContain('+39 ••• ••• 4567');
    expect(c.textContent).not.toContain('3331234567');

    setInput(c.querySelector('input[autocomplete="one-time-code"]'), '123 456');
    await submit(c);
    expect(mocks.fetch).toHaveBeenLastCalledWith('/phone-number/verify', {
      method: 'POST',
      body: { phoneNumber: '+393331234567', code: '123456' },
    });
    expect(mocks.navigate).toHaveBeenCalledWith('/premi');
  });

  it('numero non valido: errore in pagina, nessun SMS', async () => {
    const c = await mount(<PhoneSignIn mode="signup" />);
    await act(async () => button(c, 'Registrati con il numero di telefono').click());
    setInput(c.querySelector('input[type="tel"]'), '12');
    await submit(c);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('Numero non valido');
  });

  it('codice sbagliato: messaggio chiaro, resta sulla pagina', async () => {
    mocks.fetch
      .mockResolvedValueOnce({ data: { message: 'code sent' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { status: 400, code: 'INVALID_OTP' } });
    const c = await mount(<PhoneSignIn mode="login" />);
    await act(async () => button(c, 'Accedi con il numero di telefono').click());
    setInput(c.querySelector('input[type="tel"]'), '3331234567');
    await submit(c);
    setInput(c.querySelector('input[autocomplete="one-time-code"]'), '000000');
    await submit(c);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('Codice non corretto');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('troppi invii: mostra il limite ma lascia inserire un codice già ricevuto', async () => {
    // Anche se qualcun altro ha esaurito i codici di questo numero, l'SMS arrivato al titolare
    // resta valido: il blocco non diventa un lockout.
    mocks.fetch
      .mockResolvedValueOnce({
        data: null,
        error: { status: 429, message: 'Hai raggiunto il limite. Riprova tra 600 secondi.' },
      })
      .mockResolvedValueOnce({ data: { status: true }, error: null });
    const c = await mount(<PhoneSignIn mode="login" />);
    await act(async () => button(c, 'Accedi con il numero di telefono').click());
    setInput(c.querySelector('input[type="tel"]'), '3331234567');
    await submit(c);
    const alert = c.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('Riprova tra 600 secondi');
    expect(alert).toContain('puoi inserirlo qui');
    setInput(c.querySelector('input[autocomplete="one-time-code"]'), '123456');
    await submit(c);
    expect(mocks.fetch).toHaveBeenLastCalledWith('/phone-number/verify', {
      method: 'POST',
      body: { phoneNumber: '+393331234567', code: '123456' },
    });
    expect(mocks.navigate).toHaveBeenCalled();
  });

  it('SMS rifiutato da Twilio: lo dice subito e resta al passo del numero', async () => {
    mocks.fetch.mockResolvedValueOnce({
      data: null,
      error: { status: 502, code: 'SMS_NOT_SENT', message: 'Non è stato possibile inviare l’SMS.' },
    });
    const c = await mount(<PhoneSignIn mode="login" />);
    await act(async () => button(c, 'Accedi con il numero di telefono').click());
    setInput(c.querySelector('input[type="tel"]'), '3331234567');
    await submit(c);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('inviare l’SMS');
    expect(c.querySelector('input[autocomplete="one-time-code"]')).toBeNull();
  });

  it('messaggi d’errore per stato', () => {
    expect(phoneAuthErrorMessage({ status: 404 }, 'send')).toContain('non è disponibile');
    expect(phoneAuthErrorMessage({ status: 400 }, 'send')).toContain('Numero non valido');
    expect(phoneAuthErrorMessage({ status: 403, code: 'TOO_MANY_ATTEMPTS' }, 'verify')).toContain(
      'Codice non corretto',
    );
    expect(phoneAuthErrorMessage({ status: 503 }, 'send')).toContain('non è disponibile');
  });
});

describe('password dimenticata', () => {
  it('chiede il link con il percorso interno e risponde in modo neutro', async () => {
    mocks.requestPasswordReset.mockResolvedValue({ data: { status: true }, error: null });
    const c = await mount(<ForgotPasswordForm />);
    setInput(c.querySelector('input[type="email"]'), ' mario@example.com ');
    await submit(c);
    expect(mocks.requestPasswordReset).toHaveBeenCalledWith({
      email: 'mario@example.com',
      redirectTo: '/reimposta-password',
    });
    expect(c.textContent).toContain('Se esiste un account Solco con questa email');
  });

  it('limite raggiunto: lo dice, senza confermare l’invio', async () => {
    mocks.requestPasswordReset.mockResolvedValue({
      data: null,
      error: { status: 429, message: 'Troppe richieste, riprova più tardi.' },
    });
    const c = await mount(<ForgotPasswordForm />);
    setInput(c.querySelector('input[type="email"]'), 'a@b.it');
    await submit(c);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('Troppe richieste');
    expect(c.textContent).not.toContain('Se esiste un account');
  });
});

describe('nuova password dal link', () => {
  it('toglie il token dall’URL e salva la nuova password', async () => {
    window.history.replaceState(null, '', '/reimposta-password?token=tok123');
    mocks.resetPassword.mockResolvedValue({ data: { status: true }, error: null });
    const c = await mount(<ResetPasswordForm />);
    expect(window.location.search).toBe('');
    const [password, confirm] = c.querySelectorAll<HTMLInputElement>('input[type="password"]');
    setInput(password ?? null, 'nuovaPassword1');
    setInput(confirm ?? null, 'nuovaPassword1');
    await submit(c);
    expect(mocks.resetPassword).toHaveBeenCalledWith({
      newPassword: 'nuovaPassword1',
      token: 'tok123',
    });
    expect(c.textContent).toContain('Password aggiornata');
  });

  it('password diverse o troppo corte: nessuna chiamata', async () => {
    window.history.replaceState(null, '', '/reimposta-password?token=tok123');
    const c = await mount(<ResetPasswordForm />);
    const [password, confirm] = c.querySelectorAll<HTMLInputElement>('input[type="password"]');
    setInput(password ?? null, 'nuovaPassword1');
    setInput(confirm ?? null, 'altraPassword2');
    await submit(c);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('non coincidono');
    setInput(password ?? null, 'corta');
    setInput(confirm ?? null, 'corta');
    await submit(c);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('almeno 8');
    expect(mocks.resetPassword).not.toHaveBeenCalled();
  });

  it('link scaduto o già usato: invita a chiederne uno nuovo', async () => {
    window.history.replaceState(null, '', '/reimposta-password?error=INVALID_TOKEN');
    const c = await mount(<ResetPasswordForm />);
    expect(c.textContent).toContain('non è valido o è scaduto');
    expect(c.querySelector('a[href="/password-dimenticata"]')).not.toBeNull();
  });

  it('token rifiutato dal server: passa allo stato di link non valido', async () => {
    window.history.replaceState(null, '', '/reimposta-password?token=vecchio');
    mocks.resetPassword.mockResolvedValue({
      data: null,
      error: { status: 400, code: 'INVALID_TOKEN' },
    });
    const c = await mount(<ResetPasswordForm />);
    const [password, confirm] = c.querySelectorAll<HTMLInputElement>('input[type="password"]');
    setInput(password ?? null, 'nuovaPassword1');
    setInput(confirm ?? null, 'nuovaPassword1');
    await submit(c);
    expect(c.textContent).toContain('non è valido o è scaduto');
  });
});
