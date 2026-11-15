// @polsia:user-owned — pagina /admin/utenti-vecchi: nessuna connessione finché non si preme
// «Controlla i database», caricamento, errore con «Riprova», scheda «In uso» senza pulsanti di
// trasferimento, scheda incompleta e non raggiungibile, istruzioni per OLD_DATABASE_URL, anteprima →
// conferma → «Continua» fino alla fine con toast, anteprima scaduta (409) da rifare e collegamento
// dalla scheda Iscritti.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/iscritti' }));

import { LegacyUsersPanel } from '@/components/custom/admin/legacy-users-panel';
import { SignupsDashboard } from '@/components/custom/admin/signups-dashboard';
import type {
  LegacyDbGroup,
  LegacyStats,
  LegacyUsersDiagnostic,
} from '@/lib/contracts/legacy-users';

const OLD = 'a'.repeat(32);
const CURRENT = 'b'.repeat(32);
const INCOMPLETE = 'c'.repeat(32);
const BROKEN = 'd'.repeat(32);
const TOKEN = 'eyJ2IjoxfQ.c2lnbmF0dXJlLXByb3Zh';

const STATS: LegacyStats = {
  users: 6,
  verified: 5,
  banned: 1,
  withPhone: 1,
  legacyAdmins: 1,
  oldestAt: '2024-01-01T10:00:00.000Z',
  newestAt: '2024-06-01T10:00:00.000Z',
  alreadyImported: 0,
  alreadyPresent: 1,
  duplicateInSource: 0,
  invalidEmail: 1,
  importable: 3,
  passwordCompatible: 2,
  passwordIncompatible: 1,
  oauthOnly: 0,
  phoneOnly: 0,
  needsPasswordReset: 1,
  adminsToDemote: 1,
  phonesDropped: 0,
  oauthAccountsSkipped: 0,
  reservedAdmin: 0,
};

function group(patch: Partial<LegacyDbGroup>): LegacyDbGroup {
  return {
    source: OLD,
    current: false,
    status: 'ready',
    providerHint: 'Neon · us-east-2',
    envVars: ['OLD_DATABASE_URL'],
    incompleteVars: [],
    errorKind: null,
    currentUsers: null,
    otherUsersTable: null,
    stats: STATS,
    otherTables: [{ name: 'Playlist', rows: 12 }],
    otherTablesApproximate: false,
    ...patch,
  };
}

const DIAGNOSTIC: LegacyUsersDiagnostic = {
  generatedAt: '2026-11-15T10:00:00.000Z',
  batchSize: 2,
  currentDetected: true,
  groups: [
    group({
      source: CURRENT,
      current: true,
      status: 'current',
      providerHint: 'Neon · eu-central-1',
      envVars: ['DATABASE_URL', 'POSTGRES_URL'],
      currentUsers: 120,
      stats: null,
      otherTables: [],
    }),
    group({}),
    group({
      source: INCOMPLETE,
      status: 'incomplete',
      providerHint: 'AWS RDS · eu-west-1',
      envVars: ['MY_STR_PGHOST', 'MY_STR_PGUSER'],
      incompleteVars: ['MY_STR_PG*'],
      stats: null,
      otherTables: [],
    }),
    group({
      source: BROKEN,
      status: 'error',
      errorKind: 'auth',
      providerHint: 'Supabase',
      envVars: ['SOLCO_DATABASE_URL'],
      stats: null,
      otherTables: [],
    }),
  ],
  skippedVars: [],
};

const PREVIEW = {
  action: 'preview',
  source: OLD,
  stats: STATS,
  previewToken: TOKEN,
  expiresAt: '2026-11-15T10:15:00.000Z',
  batchSize: 2,
};

function batch(imported: number, remaining: number, totalImported: number) {
  return {
    action: 'import',
    source: OLD,
    batch: {
      imported,
      conflicts: 0,
      skippedExisting: 1,
      skippedInvalidEmail: 1,
      totalImported,
      remaining,
      done: remaining === 0,
    },
  };
}

type FetchInit = { method?: string; body?: string; schema?: { parse: (v: unknown) => unknown } };

/** Risponde come il vero apiFetch: lo schema del contratto valida i dati di prova. */
function respond(value: unknown) {
  return async (_path: string, init?: FetchInit) =>
    init?.schema ? init.schema.parse(value) : value;
}

function apiError(status: number, body: Record<string, unknown>) {
  return new Error(`apiFetch failed (${status})`, { cause: body });
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(node: React.ReactNode = <LegacyUsersPanel />) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(node));
  await flush();
}

function buttons(scope: ParentNode = container) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')];
}

function button(text: string, scope: ParentNode = container) {
  const found = buttons(scope).find((element) => element.textContent?.trim() === text);
  if (!found) throw new Error(`Pulsante "${text}" non trovato.`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function card(source: string) {
  const element = container.querySelector<HTMLElement>(`article[data-source="${source}"]`);
  if (!element) throw new Error(`Scheda ${source} non trovata.`);
  return element;
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="alertdialog"]');
}

/** Radix riporta il fuoco con un setTimeout(0) dopo la chiusura della finestra. */
async function nextTask() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('controllo dei database', () => {
  it('non si collega a nulla finché non premi «Controlla i database»; spiega come aggiungere OLD_DATABASE_URL', async () => {
    await mount();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(button('Controlla i database')).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).toContain('OLD_DATABASE_URL');
    expect(text).toContain('Environment Variables');
    expect(text).toContain('Production');
    expect(text).toContain('Sensitive');
    expect(text).toContain('Redeploy');
    expect(text).toContain('non incollarla mai in chat');
  });

  it('caricamento: pulsante occupato e messaggio, poi le schede', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.apiFetch.mockImplementation(
      (_path: string, init?: FetchInit) =>
        new Promise((done) => {
          resolve = (value) => done(init?.schema ? init.schema.parse(value) : value);
        }),
    );
    await mount();
    await click(button('Controlla i database'));
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/admin/legacy-users', expect.anything());
    const busy = button('Controllo in corso…');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('sola lettura');
    await act(async () => resolve(DIAGNOSTIC));
    await flush();
    expect(container.querySelectorAll('article')).toHaveLength(4);
  });

  it('errore: messaggio del server e «Riprova»', async () => {
    mocks.apiFetch.mockRejectedValueOnce(
      apiError(429, { error: 'rate_limited', message: 'Troppe richieste ravvicinate.' }),
    );
    await mount();
    await click(button('Controlla i database'));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Troppe richieste ravvicinate.');
    mocks.apiFetch.mockImplementation(respond(DIAGNOSTIC));
    await click(button('Riprova'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll('article')).toHaveLength(4);
  });

  it('schede: «In uso» senza trasferimento, incompleta, non raggiungibile, pronta con i numeri', async () => {
    mocks.apiFetch.mockImplementation(respond(DIAGNOSTIC));
    await mount();
    await click(button('Controlla i database'));

    const inUse = card(CURRENT);
    expect(inUse.textContent).toContain('In uso');
    expect(inUse.textContent).toContain('120 account');
    expect(inUse.textContent).toContain('DATABASE_URL');
    expect(buttons(inUse)).toHaveLength(0);

    const incomplete = card(INCOMPLETE);
    expect(incomplete.textContent).toContain('Incompleto');
    expect(incomplete.textContent).toContain('MY_STR_PG*');
    expect(buttons(incomplete)).toHaveLength(0);

    const broken = card(BROKEN);
    expect(broken.textContent).toContain('Non raggiungibile');
    expect(broken.textContent).toContain('Utente o password non accettati');
    expect(buttons(broken)).toHaveLength(0);

    const old = card(OLD);
    expect(old.textContent).toContain('Neon · us-east-2');
    expect(old.querySelector('[data-stat="Trasferibili"] dd')?.textContent).toBe('3');
    expect(old.querySelector('[data-stat="Password compatibili"] dd')?.textContent).toBe('2');
    expect(
      old.querySelector('[data-stat="Admin che diventeranno utenti normali"] dd')?.textContent,
    ).toBe('1');
    expect(old.textContent).toContain('Playlist');
    expect(button('Anteprima trasferimento', old)).toBeTruthy();
  });
});

describe('anteprima e trasferimento', () => {
  async function openOldCard() {
    mocks.apiFetch.mockImplementation(respond(DIAGNOSTIC));
    await mount();
    await click(button('Controlla i database'));
    return card(OLD);
  }

  it('anteprima → conferma → «Continua» finché non resta nulla → toast', async () => {
    const old = await openOldCard();
    mocks.apiFetch.mockImplementation(respond(PREVIEW));
    await click(button('Anteprima trasferimento', old));
    const call = mocks.apiFetch.mock.calls.at(-1);
    expect(call?.[0]).toBe('/api/admin/legacy-users/import');
    expect(JSON.parse(call?.[1]?.body ?? '{}')).toEqual({ action: 'preview', source: OLD });
    expect(old.textContent).toContain('3 account verranno creati.');
    expect(old.textContent).toContain('«Password dimenticata»');
    expect(old.textContent).toContain('erano admin');

    // Il pulsante apre la conferma: niente trasferimento senza conferma.
    const calls = mocks.apiFetch.mock.calls.length;
    await click(button('Trasferisci 3 account', old));
    expect(dialog()?.textContent).toContain('Trasferire 3 account?');
    expect(mocks.apiFetch.mock.calls.length).toBe(calls);

    mocks.apiFetch.mockImplementation(respond(batch(2, 1, 2)));
    await click(button('Trasferisci', dialog() ?? document));
    expect(JSON.parse(mocks.apiFetch.mock.calls.at(-1)?.[1]?.body ?? '{}')).toEqual({
      action: 'import',
      source: OLD,
      previewToken: TOKEN,
    });
    expect(old.textContent).toContain('Trasferiti 2 di 3: ne restano 1.');
    expect(mocks.toast.success).not.toHaveBeenCalled();

    mocks.apiFetch.mockImplementation(respond(batch(1, 0, 3)));
    await click(button('Continua', old));
    expect(old.textContent).toContain('Fatto: 3 account creati');
    expect(mocks.toast.success).toHaveBeenCalledWith('Trasferimento completato: 3 account creati.');
    expect(buttons(old).some((b) => b.textContent === 'Continua')).toBe(false);
  });

  it('anteprima scaduta (409): messaggio e si torna ad «Anteprima trasferimento»', async () => {
    const old = await openOldCard();
    mocks.apiFetch.mockImplementation(respond(PREVIEW));
    await click(button('Anteprima trasferimento', old));
    await click(button('Trasferisci 3 account', old));
    mocks.apiFetch.mockRejectedValueOnce(
      apiError(409, {
        error: 'preview_expired',
        message: 'L’anteprima è scaduta (vale 15 minuti). Rifai l’anteprima e conferma di nuovo.',
      }),
    );
    await click(button('Trasferisci', dialog() ?? document));
    expect(old.querySelector('[role="alert"]')?.textContent).toContain('L’anteprima è scaduta');
    expect(button('Anteprima trasferimento', old)).toBeTruthy();
    expect(mocks.toast.error).toHaveBeenCalled();
  });

  it('durante il primo lotto «Annulla» e «Trasferisci» spariscono; il risultato arriva comunque', async () => {
    const old = await openOldCard();
    mocks.apiFetch.mockImplementation(respond(PREVIEW));
    await click(button('Anteprima trasferimento', old));
    await click(button('Trasferisci 3 account', old));

    let resolve: (value: unknown) => void = () => {};
    mocks.apiFetch.mockImplementation(
      (_path: string, init?: FetchInit) =>
        new Promise((done) => {
          resolve = (value) => done(init?.schema ? init.schema.parse(value) : value);
        }),
    );
    await click(button('Trasferisci', dialog() ?? document));
    expect(old.textContent).toContain('Trasferimento del primo lotto…');
    expect(buttons(old).map((b) => b.textContent?.trim())).not.toContain('Annulla');
    expect(buttons(old).some((b) => b.textContent?.startsWith('Trasferisci'))).toBe(false);

    await act(async () => resolve(batch(2, 1, 2)));
    await flush();
    expect(old.textContent).toContain('Trasferiti 2 di 3: ne restano 1.');
    mocks.apiFetch.mockImplementation(respond(batch(1, 0, 3)));
    await click(button('Continua', old));
    const body = JSON.parse(mocks.apiFetch.mock.calls.at(-1)?.[1]?.body ?? '{}');
    expect(body).toEqual({ action: 'import', source: OLD, previewToken: TOKEN });
    expect(old.textContent).toContain('Fatto: 3 account creati');
  });

  it('fuoco dopo la conferma e avanzamento annunciato', async () => {
    const old = await openOldCard();
    mocks.apiFetch.mockImplementation(respond(PREVIEW));
    await click(button('Anteprima trasferimento', old));

    // Annullata: il fuoco torna su «Trasferisci 3 account».
    await click(button('Trasferisci 3 account', old));
    await click(button('Annulla', dialog() ?? document));
    await nextTask();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button('Trasferisci 3 account', old));

    // Confermata: il fuoco va sull'avanzamento, che resta anche quando arriva il lotto.
    await click(button('Trasferisci 3 account', old));
    mocks.apiFetch.mockImplementation(respond(batch(2, 1, 2)));
    await click(button('Trasferisci', dialog() ?? document));
    await nextTask();
    const heading = old.querySelector('h3[tabindex="-1"]');
    expect(heading?.textContent).toBe('Avanzamento del trasferimento');
    expect(document.activeElement).toBe(heading);
    const status = old.querySelector('output[aria-live="polite"]');
    expect(status?.textContent).toContain('Trasferiti 2 di 3: ne restano 1.');

    // Ultimo lotto: «Continua» sparisce e il fuoco resta nella scheda; «Fatto» annunciato.
    mocks.apiFetch.mockImplementation(respond(batch(1, 0, 3)));
    const next = button('Continua', old);
    next.focus();
    await click(next);
    expect(status?.isConnected).toBe(true);
    expect(old.querySelector('output[aria-live="polite"]')?.textContent).toContain('Fatto:');
    expect(document.activeElement).toBe(old.querySelector('h3[tabindex="-1"]'));
  });

  it('anteprima: avvisa dei «Fondatori» e delle email da amministratore non copiate', async () => {
    const old = await openOldCard();
    mocks.apiFetch.mockImplementation(
      respond({ ...PREVIEW, stats: { ...STATS, reservedAdmin: 1 } }),
    );
    await click(button('Anteprima trasferimento', old));
    expect(old.textContent).toContain('«Fondatori»');
    expect(old.textContent).toContain('30 giorni di Premium');
    expect(old.textContent).toContain(
      '1 account non copiato: email a cui il sito dà da solo il ruolo di amministratore.',
    );
    expect(container.textContent).toContain('primi 100 «Fondatori»');
  });

  it('niente da trasferire: nessun pulsante «Trasferisci»', async () => {
    const old = await openOldCard();
    mocks.apiFetch.mockImplementation(
      respond({
        ...PREVIEW,
        stats: { ...STATS, importable: 0 },
        previewToken: null,
        expiresAt: null,
      }),
    );
    await click(button('Anteprima trasferimento', old));
    expect(old.textContent).toContain('Niente da trasferire');
    expect(buttons(old).some((b) => b.textContent?.startsWith('Trasferisci'))).toBe(false);
  });
});

describe('raggiungibilità', () => {
  it('la scheda Iscritti collega «Utenti del vecchio sito»', async () => {
    mocks.apiFetch.mockReturnValue(new Promise(() => {}));
    await mount(<SignupsDashboard />);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/admin/utenti-vecchi"]');
    expect(link?.textContent).toContain('Utenti del vecchio sito');
  });
});
