// @polsia:user-owned — «Gestione account» lato client: carica concessioni e account, mostra lo stato
// di ogni concessione (attiva, in attesa del primo accesso, email non verificata, revocata,
// proprietario) e di ogni account (UID copiabile, Premium per fonte o Free, verifica, ruolo, blocco,
// accesso); concedere manda email e nota e aggiorna l'elenco, un errore di campo resta accanto al
// campo (aria-invalid), revocare chiama DELETE ?id=; la ricerca e le pagine richiedono l'elenco
// giusto. La riga «UID» del profilo mostra l'UID e lo copia.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import { AccountUidRow } from '@/components/custom/account-uid-row';
import { AccountManagementPanel } from '@/components/custom/admin/account-management';

const GRANTS = [
  {
    id: 'g-owner',
    email: 'proprietario@example.com',
    note: 'Proprietario di Solco: Premium illimitato',
    createdAt: '2026-11-15T10:00:00.000Z',
    revokedAt: null,
    status: 'active',
    account: { uid: 'SOL-7K2M-9QXD', name: 'Proprietario' },
    owner: true,
  },
  {
    id: 'g-pending',
    email: 'futuro@example.com',
    note: null,
    createdAt: '2026-11-14T10:00:00.000Z',
    revokedAt: null,
    status: 'pending',
    account: null,
    owner: false,
  },
  {
    id: 'g-unverified',
    email: 'nonverificata@example.com',
    note: null,
    createdAt: '2026-11-13T10:00:00.000Z',
    revokedAt: null,
    status: 'unverified',
    account: { uid: 'SOL-AAAA-BBBB', name: 'Non verificata' },
    owner: false,
  },
  {
    id: 'g-revoked',
    email: 'revocata@example.com',
    note: null,
    createdAt: '2026-11-12T10:00:00.000Z',
    revokedAt: '2026-11-13T10:00:00.000Z',
    status: 'revoked',
    account: null,
    owner: false,
  },
];

function accountRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    uid: `SOL-${id.toUpperCase().padEnd(4, '0').slice(0, 4)}-0000`,
    name: `Nome ${id}`,
    email: `${id}@example.com`,
    emailVerified: true,
    role: 'user',
    providers: ['email'],
    banned: false,
    premium: [],
    createdAt: '2026-11-01T10:00:00.000Z',
    ...extra,
  };
}

const ACCOUNTS = {
  items: [
    accountRow('ADMN', { role: 'admin', providers: ['google'], premium: ['unlimited'] }),
    accountRow('FREE', { emailVerified: false }),
    accountRow('BANN', { banned: true, premium: ['stripe', 'rewards'] }),
    accountRow('TELE', {
      email: '393331234567@telefono.solcomusic.invalid',
      providers: ['phone'],
    }),
  ],
  total: 30,
  page: 0,
  hasMore: true,
};

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

async function mount(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await flush();
  return container;
}

function serve(overrides: Partial<Record<'grants' | 'accounts', unknown>> = {}) {
  mocks.apiFetch.mockImplementation(
    async (url: string, init?: { method?: string; body?: string }) => {
      if (url === '/api/admin/premium-grants' && !init?.method)
        return { items: overrides.grants ?? GRANTS };
      if (url.startsWith('/api/admin/accounts')) return overrides.accounts ?? ACCOUNTS;
      if (url === '/api/admin/premium-grants' && init?.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}') as { email: string; note?: string };
        return {
          grant: {
            id: `g-${body.email}`,
            email: body.email,
            note: body.note ?? null,
            createdAt: '2026-11-15T12:00:00.000Z',
            revokedAt: null,
            status: 'pending',
            account: null,
            owner: false,
          },
        };
      }
      if (url.startsWith('/api/admin/premium-grants?id=') && init?.method === 'DELETE') {
        const id = decodeURIComponent(url.split('=')[1] ?? '');
        const found = GRANTS.find((grant) => grant.id === id);
        return { grant: { ...found, status: 'revoked', revokedAt: '2026-11-15T12:30:00.000Z' } };
      }
      if (url === '/api/account/uid') return { uid: 'SOL-7K2M-9QXD' };
      throw new Error(`URL inattesa: ${url}`);
    },
  );
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  );
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const fn of Object.values(mocks)) fn.mockReset();
  serve();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Premium illimitato', () => {
  it('stato di ogni concessione, proprietario e UID dell’account', async () => {
    const container = await mount(<AccountManagementPanel />);
    const list = container.querySelector('ul[aria-label="Concessioni del Premium illimitato"]');
    const rows = [...(list?.querySelectorAll(':scope > li') ?? [])];
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain('Attivo');
    expect(rows[0]?.textContent).toContain('Proprietario');
    expect(rows[0]?.textContent).toContain('SOL-7K2M-9QXD');
    expect(rows[1]?.textContent).toContain('In attesa del primo accesso');
    expect(rows[2]?.textContent).toContain('Email non verificata');
    expect(rows[3]?.textContent).toContain('Revocato');
    expect(buttonByText(rows[3] as HTMLElement, 'Riattiva')).toBeDefined();
    expect(buttonByText(rows[0] as HTMLElement, 'Revoca')).toBeDefined();
  });

  it('concedere: email e nota al server, elenco aggiornato, campi svuotati', async () => {
    const container = await mount(<AccountManagementPanel />);
    const [email, note] = [...container.querySelectorAll<HTMLInputElement>('form input')];
    await type(email as HTMLInputElement, 'nuovo@example.com');
    await type(note as HTMLInputElement, 'Tester');
    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    const call = mocks.apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({
      email: 'nuovo@example.com',
      note: 'Tester',
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Premium illimitato concesso a nuovo@example.com.',
    );
    expect(container.textContent).toContain('nuovo@example.com');
    expect((email as HTMLInputElement).value).toBe('');
  });

  it('errore di campo: accanto al campo, con aria-invalid', async () => {
    serve();
    mocks.apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        throw new Error('apiFetch failed (400)', {
          cause: { errors: { email: 'Scrivi un indirizzo email valido.' } },
        });
      }
      if (url.startsWith('/api/admin/accounts')) return ACCOUNTS;
      return { items: GRANTS };
    });
    const container = await mount(<AccountManagementPanel />);
    const email = container.querySelector<HTMLInputElement>('form input') as HTMLInputElement;
    await type(email, 'sbagliata');
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    const describedBy = email.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Scrivi un indirizzo email valido.',
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('revocare chiama DELETE ?id= e mostra «Revocato»', async () => {
    const container = await mount(<AccountManagementPanel />);
    const list = container.querySelector('ul[aria-label="Concessioni del Premium illimitato"]');
    const first = list?.querySelector(':scope > li') as HTMLElement;
    await act(async () => buttonByText(first, 'Revoca')?.click());
    await flush();
    expect(
      mocks.apiFetch.mock.calls.some(
        ([url, init]) =>
          url === '/api/admin/premium-grants?id=g-owner' && init?.method === 'DELETE',
      ),
    ).toBe(true);
    expect(first.textContent).toContain('Revocato');
  });
});

describe('Account', () => {
  it('UID, Premium per fonte o Free, verifica, ruolo, blocco e accesso', async () => {
    const container = await mount(<AccountManagementPanel />);
    const rows = [...container.querySelectorAll('ul[aria-label="Account"] > li')];
    expect(rows).toHaveLength(4);
    // Account col telefono: il numero al posto dell'email segnaposto, nessun badge dell'email.
    expect(rows[3]?.textContent).toContain('Telefono +393331234567');
    expect(rows[3]?.textContent).not.toContain('telefono.solcomusic.invalid');
    expect(rows[3]?.textContent).not.toContain('Email verificata');
    expect(rows[3]?.textContent).toContain('Accesso: Telefono');
    expect(rows[0]?.textContent).toContain('Premium · Illimitato');
    expect(rows[0]?.textContent).toContain('Amministratore');
    expect(rows[0]?.textContent).toContain('Accesso: Google');
    expect(rows[1]?.textContent).toContain('Free');
    expect(rows[1]?.textContent).toContain('Email non verificata');
    expect(rows[2]?.textContent).toContain('Premium · Stripe, Premi');
    expect(rows[2]?.textContent).toContain('Bloccato');
    expect(rows[0]?.querySelector('button[aria-label^="Copia l’UID"]')).not.toBeNull();
    expect(container.textContent).toContain('30 account');
  });

  it('ricerca e pagina successiva chiedono l’elenco giusto', async () => {
    const container = await mount(<AccountManagementPanel />);
    const search = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    ) as HTMLInputElement;
    await type(search, 'SOL-7K2M-9QXD');
    await act(async () => {
      search.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/admin/accounts?q=SOL-7K2M-9QXD&page=0',
      expect.anything(),
    );
    await act(async () => buttonByText(container, 'Successivi')?.click());
    await flush();
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/admin/accounts?q=SOL-7K2M-9QXD&page=1',
      expect.anything(),
    );
  });
});

describe('riga «UID» del profilo', () => {
  it('mostra l’UID e lo copia', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const container = await mount(<AccountUidRow />);
    expect(container.textContent).toContain('SOL-7K2M-9QXD');
    const button = container.querySelector<HTMLButtonElement>('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Copia l’UID SOL-7K2M-9QXD');
    await act(async () => button.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith('SOL-7K2M-9QXD');
    expect(button.getAttribute('aria-label')).toBe('UID copiato');
  });

  it('se non arriva: «non disponibile»', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('down'));
    const container = await mount(<AccountUidRow />);
    expect(container.textContent).toContain('non disponibile');
  });
});
