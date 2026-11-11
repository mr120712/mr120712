// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
  signUpEmail: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock('@/lib/auth-client', () => ({
  signIn: { email: mocks.signInEmail, social: mocks.signInSocial },
  signUp: { email: mocks.signUpEmail },
}));

import { SignInForm } from '@/components/custom/sign-in-form';
import { SignUpForm } from '@/components/custom/sign-up-form';
import {
  emailAuthErrorMessage,
  emailAuthNetworkErrorMessage,
  safeAuthDestination,
} from '@/lib/business/auth-form';

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

async function mount(element: React.ReactNode, path: string) {
  window.history.replaceState({}, '', path);
  const container = document.createElement('div');
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => root.render(element));
  return container;
}

async function setValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(container: HTMLElement) {
  const form = container.querySelector('form');
  if (!form) throw new Error('Modulo di autenticazione mancante.');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function fill(container: HTMLElement, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    const input = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!input) throw new Error(`Campo ${name} mancante.`);
    await setValue(input, value);
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.signInEmail.mockReset();
  mocks.signInSocial.mockReset().mockResolvedValue({ error: null });
  mocks.signUpEmail.mockReset();
  mocks.replace.mockReset();
  mocks.refresh.mockReset();
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('form di accesso Solco', () => {
  it.each([
    ['login', () => <SignInForm />],
    ['signup', () => <SignUpForm />],
  ])('%s non mostra Google e conserva il percorso Apple', async (route, createForm) => {
    const container = await mount(createForm(), `/${route}`);
    expect(container.textContent?.toLowerCase()).not.toContain('google');

    const apple = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Continua con Apple'),
    );
    expect(apple).toBeTruthy();
    await act(async () => {
      apple?.click();
      await Promise.resolve();
    });
    expect(mocks.signInSocial).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'apple', callbackURL: '/dashboard' }),
    );
  });

  it('invia email e password e apre la destinazione predefinita /dashboard', async () => {
    mocks.signInEmail.mockResolvedValue({ error: null });
    const container = await mount(<SignInForm />, '/login');
    await fill(container, { email: 'ascoltatore@example.test', password: 'password-valid' });
    await submit(container);

    expect(mocks.signInEmail).toHaveBeenCalledWith({
      email: 'ascoltatore@example.test',
      password: 'password-valid',
      callbackURL: '/dashboard',
    });
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard');
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('mantiene la callback locale e mostra un errore chiaro per credenziali errate', async () => {
    mocks.signInEmail.mockResolvedValue({
      error: { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 },
    });
    const container = await mount(
      <SignInForm />,
      '/login?callbackURL=%2Fprofile%3Ftab%3Dascolti',
    );
    await fill(container, { email: 'ascoltatore@example.test', password: 'errata-pass' });
    await submit(container);

    expect(mocks.signInEmail).toHaveBeenCalledWith(
      expect.objectContaining({ callbackURL: '/profile?tab=ascolti' }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Email o password non corretti',
    );
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('mostra un messaggio chiaro quando la richiesta fallisce per rete o servizio', async () => {
    mocks.signInEmail.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const networkContainer = await mount(<SignInForm />, '/login');
    await fill(networkContainer, { email: 'a@example.test', password: 'password-valid' });
    await submit(networkContainer);
    expect(networkContainer.querySelector('[role="alert"]')?.textContent).toContain(
      'Connessione non riuscita',
    );

    mocks.signInEmail.mockResolvedValueOnce({ error: { code: 'INTERNAL_SERVER_ERROR', status: 500 } });
    const serviceContainer = await mount(<SignInForm />, '/login');
    await fill(serviceContainer, { email: 'a@example.test', password: 'password-valid' });
    await submit(serviceContainer);
    expect(serviceContainer.querySelector('[role="alert"]')?.textContent).toContain(
      'servizio di accesso non è disponibile',
    );
  });
});

describe('form di registrazione Solco', () => {
  it('crea l’account con nome, email e password e segue la callback locale', async () => {
    mocks.signUpEmail.mockResolvedValue({ error: null });
    const container = await mount(
      <SignUpForm />,
      '/signup?callbackURL=%2Fdashboard%2Fcollections',
    );
    await fill(container, {
      name: 'Ada Ascoltatrice',
      email: 'ada@example.test',
      password: 'password-valid',
    });
    await submit(container);

    expect(mocks.signUpEmail).toHaveBeenCalledWith({
      name: 'Ada Ascoltatrice',
      email: 'ada@example.test',
      password: 'password-valid',
      callbackURL: '/dashboard/collections',
    });
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard/collections');
    expect(container.textContent).toContain('verificare l’indirizzo email');
  });

  it('spiega quando l’email esiste già o i dati vengono rifiutati', async () => {
    mocks.signUpEmail.mockResolvedValueOnce({
      error: { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', status: 422 },
    });
    const duplicateContainer = await mount(<SignUpForm />, '/signup');
    await fill(duplicateContainer, {
      name: 'Ada',
      email: 'ada@example.test',
      password: 'password-valid',
    });
    await submit(duplicateContainer);
    expect(duplicateContainer.querySelector('[role="alert"]')?.textContent).toContain(
      'Esiste già un account con questa email',
    );

    mocks.signUpEmail.mockResolvedValueOnce({ error: { code: 'INVALID_EMAIL', status: 400 } });
    const invalidContainer = await mount(<SignUpForm />, '/signup');
    await fill(invalidContainer, {
      name: 'Ada',
      email: 'non-valida',
      password: 'password-valid',
    });
    await submit(invalidContainer);
    expect(invalidContainer.querySelector('[role="alert"]')?.textContent).toContain(
      'Inserisci un indirizzo email valido',
    );
  });

  it('mostra un messaggio chiaro per errori di rete o del servizio', async () => {
    mocks.signUpEmail.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const networkContainer = await mount(<SignUpForm />, '/signup');
    await fill(networkContainer, {
      name: 'Ada',
      email: 'ada@example.test',
      password: 'password-valid',
    });
    await submit(networkContainer);
    expect(networkContainer.querySelector('[role="alert"]')?.textContent).toContain(
      'Connessione non riuscita',
    );

    mocks.signUpEmail.mockResolvedValueOnce({ error: { code: 'INTERNAL_SERVER_ERROR', status: 500 } });
    const serviceContainer = await mount(<SignUpForm />, '/signup');
    await fill(serviceContainer, {
      name: 'Ada',
      email: 'ada@example.test',
      password: 'password-valid',
    });
    await submit(serviceContainer);
    expect(serviceContainer.querySelector('[role="alert"]')?.textContent).toContain(
      'servizio di accesso non è disponibile',
    );
  });
});

describe('messaggi e callback email', () => {
  it('rifiuta callback esterne e conserva un fallback locale', () => {
    expect(safeAuthDestination('/dashboard?tab=recenti')).toBe('/dashboard?tab=recenti');
    expect(safeAuthDestination('https://example.com')).toBe('/dashboard');
    expect(safeAuthDestination('//example.com')).toBe('/dashboard');
    expect(safeAuthDestination('/\\example.com')).toBe('/dashboard');
  });

  it('restituisce messaggi comprensibili per errori di rete e validazione', () => {
    expect(emailAuthNetworkErrorMessage()).toContain('Connessione non riuscita');
    expect(emailAuthErrorMessage({ code: 'PASSWORD_TOO_SHORT', status: 400 }, 'signup')).toContain(
      'almeno 8 caratteri',
    );
  });
});
