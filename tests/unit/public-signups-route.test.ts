// @polsia:user-owned — GET /api/public/iscritti: conteggi con Prisma finto (where su banned e
// createdAt, NULL = non bloccato, finestra mobile di 7×24 ore), cache in memoria di 20 secondi,
// Cache-Control corto (un nuovo account compare entro ~1 minuto), single-flight, scadenza di
// 4 secondi sul conteggio (un database appeso non blocca l'istanza), pausa dopo un errore, ultimo
// valore riusato se recente solo quando il database non risponde, un solo log per conteggio
// fallito, 503 "no-store" con corpo generico e risposta con i soli tre campi del contratto.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ count: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { user: { count: mocks.count } } }));

import {
  PUBLIC_SIGNUPS_INFLIGHT_MAX_AGE_MS,
  PUBLIC_SIGNUPS_TIMEOUT_MS,
  PUBLIC_SIGNUPS_TTL_MS,
} from '@/lib/business/public-signups.server';
import { PublicSignupsSchema } from '@/lib/contracts/public-signups';

type RouteModule = typeof import('@/app/api/public/iscritti/route');

const NOW = new Date('2026-11-14T14:30:00.000Z');
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
const MINUTE_MS = 60_000;

const NOT_BANNED = { OR: [{ banned: false }, { banned: null }] };

type FakeUser = { banned: boolean | null; createdAt: Date };
type Where = Record<string, unknown>;

/**
 * Valuta il sottoinsieme di `where` che la route deve usare, con la semantica SQL di Prisma:
 * `banned: false` è "= false" (esclude NULL), `banned: null` è "IS NULL". Qualunque altra chiave
 * (es. un `not`) fa fallire il test: così un filtro che perderebbe i NULL non passa inosservato.
 */
function matches(user: FakeUser, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Where[]).some((branch) => matches(user, branch));
    if (key === 'banned') return user.banned === condition;
    if (key === 'createdAt') {
      const { gte, ...rest } = condition as { gte: Date };
      if (Object.keys(rest).length > 0) throw new Error(`filtro createdAt inatteso: ${key}`);
      return user.createdAt.getTime() >= gte.getTime();
    }
    throw new Error(`chiave where non prevista: ${key}`);
  });
}

function fakeDb(users: FakeUser[]) {
  mocks.count.mockImplementation(
    async ({ where }: { where: Where }) => users.filter((user) => matches(user, where)).length,
  );
}

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

const USERS: FakeUser[] = [
  { banned: false, createdAt: ago(60 * DAY_MS) },
  { banned: null, createdAt: ago(90 * DAY_MS) }, // vecchio account: banned NULL = non bloccato
  { banned: true, createdAt: ago(30 * DAY_MS) }, // bloccato: mai contato
  { banned: false, createdAt: ago(DAY_MS) },
  { banned: null, createdAt: ago(2 * DAY_MS) },
  { banned: true, createdAt: ago(DAY_MS) }, // bloccato e recente: escluso anche dai nuovi
  { banned: false, createdAt: ago(WEEK_MS) }, // esattamente 7×24 ore fa: incluso
  { banned: false, createdAt: ago(WEEK_MS + 1) }, // 1 ms prima: fuori dalla finestra
];

let GET: RouteModule['GET'];
let errors: MockInstance<typeof console.error>;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Modulo ricaricato: la cache in memoria riparte vuota a ogni test.
  vi.resetModules();
  ({ GET } = await import('@/app/api/public/iscritti/route'));
});

afterEach(() => {
  vi.useRealTimers();
  errors.mockRestore();
});

/** Anche setTimeout finto (la scadenza del conteggio); va prima ripristinato il solo Date finto. */
function fakeTimeouts() {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('GET /api/public/iscritti', () => {
  it('conta i non bloccati (NULL compreso) e i nuovi delle ultime 7×24 ore', async () => {
    fakeDb(USERS);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      total: 6,
      last7Days: 3,
      updatedAt: NOW.toISOString(),
    });

    expect(mocks.count).toHaveBeenCalledTimes(2);
    expect(mocks.count).toHaveBeenCalledWith({ where: NOT_BANNED });
    expect(mocks.count).toHaveBeenCalledWith({
      where: { ...NOT_BANNED, createdAt: { gte: new Date(NOW.getTime() - WEEK_MS) } },
    });
  });

  it('il filtro sui bloccati tiene esplicitamente i NULL (nessun `not: true`)', async () => {
    fakeDb([
      { banned: null, createdAt: ago(DAY_MS) },
      { banned: null, createdAt: ago(40 * DAY_MS) },
      { banned: true, createdAt: ago(DAY_MS) },
    ]);
    const response = await GET();
    expect(await response.json()).toMatchObject({ total: 2, last7Days: 1 });
    for (const [args] of mocks.count.mock.calls) {
      expect(JSON.stringify(args)).not.toContain('"not"');
      expect(args.where.OR).toContainEqual({ banned: null });
    }
  });

  it('risposta pubblica e memorizzabile, con i soli tre campi del contratto', async () => {
    fakeDb(USERS);
    const response = await GET();
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=20, stale-while-revalidate=20',
    );
    expect(response.headers.get('vary')).toBeNull();
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['last7Days', 'total', 'updatedAt']);
    expect(PublicSignupsSchema.parse(body)).toEqual(body);
  });

  it('il contratto rifiuta campi in più, numeri negativi e date non ISO', () => {
    const valid = { total: 3, last7Days: 1, updatedAt: NOW.toISOString() };
    expect(PublicSignupsSchema.parse(valid)).toEqual(valid);
    expect(() => PublicSignupsSchema.parse({ ...valid, banned: 2 })).toThrow();
    expect(() => PublicSignupsSchema.parse({ ...valid, total: -1 })).toThrow();
    expect(() => PublicSignupsSchema.parse({ ...valid, last7Days: 1.5 })).toThrow();
    expect(() => PublicSignupsSchema.parse({ ...valid, updatedAt: 'ieri' })).toThrow();
  });

  it('i nuovi non superano mai il totale (iscrizione arrivata tra le due query)', async () => {
    mocks.count.mockImplementation(async ({ where }: { where: Where }) =>
      'createdAt' in where ? 5 : 4,
    );
    expect(await (await GET()).json()).toMatchObject({ total: 4, last7Days: 4 });
  });

  it('freschezza: memoria + s-maxage + stale-while-revalidate restano entro ~1 minuto', async () => {
    fakeDb(USERS);
    const header = (await GET()).headers.get('cache-control') ?? '';
    const seconds = (name: string) => Number(new RegExp(`${name}=(\\d+)`).exec(header)?.[1]);
    // Il browser chiede sempre alla CDN: nessuna copia locale che allunghi l'attesa.
    expect(seconds('max-age')).toBe(0);
    const cdnMs = (seconds('s-maxage') + seconds('stale-while-revalidate')) * 1000;
    expect(cdnMs).toBe(40_000);
    // Caso normale: valore dell'istanza (< TTL) + CDN = 60 s.
    expect(PUBLIC_SIGNUPS_TTL_MS + cdnMs).toBe(60_000);
    // Caso limite: richiesta arrivata durante un conteggio (< TTL + 4 s) + CDN = 64 s.
    expect(PUBLIC_SIGNUPS_INFLIGHT_MAX_AGE_MS + cdnMs).toBeLessThanOrEqual(70_000);
  });

  it('cache di 20 secondi: prima nessuna query, poi il nuovo iscritto compare', async () => {
    const users = [...USERS];
    fakeDb(users);
    await GET();
    expect(mocks.count).toHaveBeenCalledTimes(2);

    // Un nuovo account appena dopo il conteggio: per 20 secondi resta il valore in memoria.
    users.push({ banned: null, createdAt: new Date(NOW.getTime() + 1_000) });
    vi.setSystemTime(new Date(NOW.getTime() + PUBLIC_SIGNUPS_TTL_MS - 1));
    const cached = await GET();
    expect(cached.status).toBe(200);
    expect(await cached.json()).toMatchObject({ total: 6, updatedAt: NOW.toISOString() });
    expect(mocks.count).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date(NOW.getTime() + PUBLIC_SIGNUPS_TTL_MS));
    const later = new Date();
    const fresh = await GET();
    // Nuovi: +1 (il nuovo account) −1 (quello di esattamente 7×24 ore fa, uscito dalla finestra
    // mobile spostata di 20 secondi).
    expect(await fresh.json()).toEqual({
      total: 7,
      last7Days: 3,
      updatedAt: later.toISOString(),
    });
    expect(mocks.count).toHaveBeenCalledTimes(4);
  });

  it('single-flight: richieste contemporanee condividono un solo conteggio', async () => {
    const total = deferred<number>();
    const recent = deferred<number>();
    mocks.count.mockImplementation(({ where }: { where: Where }) =>
      'createdAt' in where ? recent.promise : total.promise,
    );

    const pending = [GET(), GET(), GET()];
    await Promise.resolve();
    expect(mocks.count).toHaveBeenCalledTimes(2);

    total.resolve(42);
    recent.resolve(7);
    const responses = await Promise.all(pending);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        total: 42,
        last7Days: 7,
        updatedAt: NOW.toISOString(),
      });
    }
    expect(mocks.count).toHaveBeenCalledTimes(2);
  });

  it('errore del database: 503 "no-store", corpo generico, log col solo nome dell’errore', async () => {
    mocks.count.mockRejectedValue(
      new Error('connect ECONNREFUSED postgres://solco:segreto@db.interno:5432/solco'),
    );
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('60');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'unavailable' });
    expect(text).not.toMatch(/postgres|segreto|ECONNREFUSED/);
    expect(errors).toHaveBeenCalledWith('[public/iscritti] conteggio non disponibile:', 'Error');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('segreto');
  });

  it('dopo un errore non riprova per 30 secondi (nessuna query a richiesta)', async () => {
    mocks.count.mockRejectedValue(new Error('down'));
    expect((await GET()).status).toBe(503);
    expect(mocks.count).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date(NOW.getTime() + 29_000));
    expect((await GET()).status).toBe(503);
    expect(mocks.count).toHaveBeenCalledTimes(2);

    fakeDb(USERS);
    vi.setSystemTime(new Date(NOW.getTime() + 30_000));
    const recovered = await GET();
    expect(recovered.status).toBe(200);
    expect(mocks.count).toHaveBeenCalledTimes(4);
  });

  it('database giù dopo la scadenza: riusa l’ultimo valore se ha meno di un’ora, poi 503', async () => {
    fakeDb(USERS);
    await GET();

    mocks.count.mockRejectedValue(new Error('down'));
    vi.setSystemTime(new Date(NOW.getTime() + 6 * MINUTE_MS));
    const stale = await GET();
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({
      total: 6,
      last7Days: 3,
      updatedAt: NOW.toISOString(),
    });

    vi.setSystemTime(new Date(NOW.getTime() + 61 * MINUTE_MS));
    const expired = await GET();
    expect(expired.status).toBe(503);
    expect(expired.headers.get('cache-control')).toBe('no-store');
  });

  it('conteggio appeso col valore appena scaduto: le altre richieste non aspettano, chi lo ha avviato al massimo 4 s', async () => {
    fakeTimeouts();
    fakeDb(USERS);
    await GET();

    // Cache appena scaduta (21 secondi) e database che non risponde più.
    vi.setSystemTime(new Date(NOW.getTime() + PUBLIC_SIGNUPS_TTL_MS + 1_000));
    mocks.count.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const first = GET().then((response) => {
      settled = true;
      return response;
    });
    await Promise.resolve();
    expect(mocks.count).toHaveBeenCalledTimes(4);

    // Mentre il conteggio è appeso, le altre visite ricevono subito l'ultimo valore.
    const others = await Promise.all([GET(), GET(), GET()]);
    for (const response of others) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ total: 6, updatedAt: NOW.toISOString() });
    }
    expect(mocks.count).toHaveBeenCalledTimes(4);
    expect(settled).toBe(false);

    // Allo scadere dei 4 secondi anche la prima riceve l'ultimo valore; un solo log.
    await vi.advanceTimersByTimeAsync(PUBLIC_SIGNUPS_TIMEOUT_MS);
    const response = await first;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 6, updatedAt: NOW.toISOString() });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(
      '[public/iscritti] conteggio non disponibile:',
      'PublicSignupsTimeoutError',
    );

    // Poi pausa di 30 secondi: nessuna nuova query, sempre l'ultimo valore.
    expect((await GET()).status).toBe(200);
    expect(mocks.count).toHaveBeenCalledTimes(4);
  });

  it('istanza rimasta ferma: chi arriva durante il conteggio aspetta lo stesso conteggio e vede il numero nuovo', async () => {
    fakeDb(USERS);
    await GET();

    // Nessuna visita per 6 minuti: il valore in memoria è troppo vecchio per darlo subito.
    vi.setSystemTime(new Date(NOW.getTime() + 6 * MINUTE_MS));
    const total = deferred<number>();
    const recent = deferred<number>();
    mocks.count.mockImplementation(({ where }: { where: Where }) =>
      'createdAt' in where ? recent.promise : total.promise,
    );
    let settled = 0;
    const pending = [GET(), GET(), GET()].map((request) =>
      request.then((response) => {
        settled += 1;
        return response;
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.count).toHaveBeenCalledTimes(4);
    expect(settled).toBe(0);

    total.resolve(9);
    recent.resolve(4);
    for (const response of await Promise.all(pending)) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ total: 9, last7Days: 4 });
    }
    expect(mocks.count).toHaveBeenCalledTimes(4);
  });

  it('istanza rimasta ferma e database appeso: dopo 4 s tutti ricevono l’ultimo valore (ripiego)', async () => {
    fakeTimeouts();
    fakeDb(USERS);
    await GET();

    vi.setSystemTime(new Date(NOW.getTime() + 6 * MINUTE_MS));
    mocks.count.mockImplementation(() => new Promise(() => {}));
    const pending = Promise.all([GET(), GET(), GET()]);
    await vi.advanceTimersByTimeAsync(PUBLIC_SIGNUPS_TIMEOUT_MS);
    for (const response of await pending) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ total: 6, updatedAt: NOW.toISOString() });
    }
    expect(mocks.count).toHaveBeenCalledTimes(4);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('conteggio appeso a cache vuota: dopo 4 s 503 "no-store", nessuna richiesta resta appesa', async () => {
    fakeTimeouts();
    mocks.count.mockImplementation(() => new Promise(() => {}));
    const pending = Promise.all([GET(), GET()]);
    await vi.advanceTimersByTimeAsync(PUBLIC_SIGNUPS_TIMEOUT_MS);
    for (const response of await pending) {
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'unavailable' });
    }
    expect(mocks.count).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('un solo log per conteggio fallito, non uno per richiesta (anche durante la pausa)', async () => {
    mocks.count.mockRejectedValue(new Error('down'));
    // Richieste contemporanee che condividono il conteggio fallito.
    const together = await Promise.all([GET(), GET(), GET()]);
    for (const response of together) expect(response.status).toBe(503);
    // Molte visite durante la pausa di 30 secondi: nessuna query e nessun log in più.
    for (let index = 0; index < 50; index += 1) {
      vi.setSystemTime(new Date(NOW.getTime() + index * 500));
      expect((await GET()).status).toBe(503);
    }
    expect(mocks.count).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledTimes(1);

    // Il conteggio successivo, se fallisce, si registra di nuovo (una volta).
    vi.setSystemTime(new Date(NOW.getTime() + 30_000));
    expect((await GET()).status).toBe(503);
    expect(mocks.count).toHaveBeenCalledTimes(4);
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('un errore non resta in cache come valore', async () => {
    mocks.count.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'));
    expect((await GET()).status).toBe(503);
    fakeDb(USERS);
    vi.setSystemTime(new Date(NOW.getTime() + 31_000));
    expect((await GET()).status).toBe(200);
  });
});
