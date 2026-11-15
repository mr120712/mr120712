// @polsia:user-owned — getPublicSignups (cache in memoria del contatore pubblico) con orologio e
// timer finti: il valore si rinnova allo scadere dei 20 secondi (un nuovo account compare entro
// ~1 minuto con la CDN), il database riceve al massimo una coppia di COUNT ogni 20 secondi anche
// sotto traffico continuo, il conteggio resta single-flight e il ripiego sull'ultimo valore
// (fino a un'ora) vale come prima solo quando il database non risponde.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ count: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { user: { count: mocks.count } } }));

type ServerModule = typeof import('@/lib/business/public-signups.server');

const NOW = new Date('2026-11-15T10:00:00.000Z');
const MINUTE_MS = 60_000;

let server: ServerModule;
let errors: MockInstance<typeof console.error>;

/** Database finto: `total` iscritti, `recent` dei quali negli ultimi 7 giorni. */
function db(total: number, recent = total) {
  mocks.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    'createdAt' in where ? recent : total,
  );
}

/** Coppie di COUNT eseguite finora (due query per conteggio). */
function countPairs(): number {
  return mocks.count.mock.calls.length / 2;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Promessa già risolta o no, senza aspettarla. */
function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Modulo ricaricato: la cache in memoria riparte vuota a ogni test.
  vi.resetModules();
  server = await import('@/lib/business/public-signups.server');
});

afterEach(() => {
  vi.useRealTimers();
  errors.mockRestore();
});

describe('getPublicSignups: cache di 20 secondi', () => {
  it('durate: memoria 20 s, valore dato durante un conteggio < 24 s, ripiego 1 ora, pausa 30 s', () => {
    expect(server.PUBLIC_SIGNUPS_TTL_MS).toBe(20_000);
    expect(server.PUBLIC_SIGNUPS_INFLIGHT_MAX_AGE_MS).toBe(24_000);
    expect(server.PUBLIC_SIGNUPS_STALE_MAX_MS).toBe(60 * MINUTE_MS);
    expect(server.PUBLIC_SIGNUPS_RETRY_MS).toBe(30_000);
    expect(server.PUBLIC_SIGNUPS_TIMEOUT_MS).toBe(4_000);
  });

  it('il nuovo account compare allo scadere dei 20 secondi, non prima', async () => {
    db(4);
    expect(await server.getPublicSignups()).toMatchObject({ total: 4, last7Days: 4 });

    db(5);
    vi.advanceTimersByTime(server.PUBLIC_SIGNUPS_TTL_MS - 1);
    expect(await server.getPublicSignups()).toMatchObject({
      total: 4,
      updatedAt: NOW.toISOString(),
    });
    expect(countPairs()).toBe(1);

    vi.advanceTimersByTime(1);
    expect(await server.getPublicSignups()).toEqual({
      total: 5,
      last7Days: 5,
      updatedAt: new Date(NOW.getTime() + server.PUBLIC_SIGNUPS_TTL_MS).toISOString(),
    });
    expect(countPairs()).toBe(2);
  });

  it('traffico continuo (una visita al secondo per 3 minuti): al massimo una coppia di COUNT ogni 20 s', async () => {
    db(4);
    for (let second = 0; second < 180; second += 1) {
      await server.getPublicSignups();
      vi.advanceTimersByTime(1_000);
    }
    // 180 s / 20 s = 9 conteggi, cioè 18 query: 3 coppie al minuto per istanza.
    expect(countPairs()).toBe(9);
  });

  it('single-flight allo scadere: una sola coppia di query, gli altri ricevono subito il valore appena scaduto', async () => {
    db(4);
    await server.getPublicSignups();

    vi.advanceTimersByTime(server.PUBLIC_SIGNUPS_TTL_MS + 1_000);
    const total = deferred<number>();
    const recent = deferred<number>();
    mocks.count.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      'createdAt' in where ? recent.promise : total.promise,
    );

    const first = server.getPublicSignups();
    const firstState = track(first);
    const others = await Promise.all([server.getPublicSignups(), server.getPublicSignups()]);
    for (const value of others) expect(value).toMatchObject({ total: 4 });
    expect(countPairs()).toBe(2);
    expect(firstState.settled).toBe(false);

    total.resolve(5);
    recent.resolve(5);
    expect(await first).toMatchObject({ total: 5 });
    // Dopo il conteggio la cache è nuova: nessuna query in più.
    expect(await server.getPublicSignups()).toMatchObject({ total: 5 });
    expect(countPairs()).toBe(2);
  });

  it('valore più vecchio di 24 s a database sano: chi arriva durante il conteggio lo aspetta (single-flight)', async () => {
    db(4);
    await server.getPublicSignups();

    vi.advanceTimersByTime(server.PUBLIC_SIGNUPS_INFLIGHT_MAX_AGE_MS);
    const total = deferred<number>();
    const recent = deferred<number>();
    mocks.count.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      'createdAt' in where ? recent.promise : total.promise,
    );

    const pending = [server.getPublicSignups(), server.getPublicSignups()];
    const states = pending.map(track);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.every((state) => !state.settled)).toBe(true);
    expect(countPairs()).toBe(2);

    total.resolve(6);
    recent.resolve(2);
    for (const value of await Promise.all(pending)) {
      expect(value).toMatchObject({ total: 6, last7Days: 2 });
    }
    expect(countPairs()).toBe(2);
  });
});

describe('getPublicSignups: ripiego quando il database non risponde (invariato)', () => {
  it('scaduti i 20 s e database giù: l’ultimo valore fino a un’ora, pausa di 30 s, poi errore', async () => {
    db(4);
    await server.getPublicSignups();

    mocks.count.mockRejectedValue(new Error('down'));
    vi.advanceTimersByTime(10 * MINUTE_MS);
    expect(await server.getPublicSignups()).toMatchObject({
      total: 4,
      updatedAt: NOW.toISOString(),
    });
    expect(countPairs()).toBe(2);
    expect(errors).toHaveBeenCalledTimes(1);

    // Pausa di 30 secondi: nessuna query, sempre l'ultimo valore.
    vi.advanceTimersByTime(server.PUBLIC_SIGNUPS_RETRY_MS - 1);
    expect(await server.getPublicSignups()).toMatchObject({ total: 4 });
    expect(countPairs()).toBe(2);

    // Oltre l'ora il valore non si riusa più.
    vi.setSystemTime(new Date(NOW.getTime() + server.PUBLIC_SIGNUPS_STALE_MAX_MS));
    await expect(server.getPublicSignups()).rejects.toBeInstanceOf(
      server.PublicSignupsUnavailableError,
    );
    expect(countPairs()).toBe(3);
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('dopo un errore, durante il nuovo tentativo gli altri ricevono subito l’ultimo valore (anche se ha minuti)', async () => {
    db(4);
    await server.getPublicSignups();

    mocks.count.mockRejectedValue(new Error('down'));
    vi.advanceTimersByTime(10 * MINUTE_MS);
    await server.getPublicSignups();

    // Finita la pausa, il nuovo tentativo resta appeso: chi arriva non lo aspetta.
    vi.advanceTimersByTime(server.PUBLIC_SIGNUPS_RETRY_MS);
    mocks.count.mockImplementation(() => new Promise(() => {}));
    const retry = server.getPublicSignups();
    const retryState = track(retry);
    expect(await server.getPublicSignups()).toMatchObject({ total: 4 });
    expect(countPairs()).toBe(3);
    expect(retryState.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(server.PUBLIC_SIGNUPS_TIMEOUT_MS);
    expect(await retry).toMatchObject({ total: 4 });
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('il database torna: il conteggio successivo aggiorna il numero e azzera il ripiego', async () => {
    db(4);
    await server.getPublicSignups();

    mocks.count.mockRejectedValue(new Error('down'));
    vi.advanceTimersByTime(server.PUBLIC_SIGNUPS_TTL_MS);
    expect(await server.getPublicSignups()).toMatchObject({ total: 4 });

    db(7);
    vi.advanceTimersByTime(server.PUBLIC_SIGNUPS_RETRY_MS);
    expect(await server.getPublicSignups()).toMatchObject({ total: 7 });

    // Di nuovo a database sano: un valore più vecchio di 24 s non si dà durante un conteggio.
    vi.advanceTimersByTime(server.PUBLIC_SIGNUPS_INFLIGHT_MAX_AGE_MS);
    const total = deferred<number>();
    mocks.count.mockImplementation(() => total.promise);
    const pending = [server.getPublicSignups(), server.getPublicSignups()];
    const states = pending.map(track);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.some((state) => state.settled)).toBe(false);
    total.resolve(8);
    for (const value of await Promise.all(pending)) expect(value).toMatchObject({ total: 8 });
  });

  it('errore vecchio (30 minuti senza visite, database tornato): chi arriva durante il conteggio aspetta il numero nuovo', async () => {
    db(4);
    await server.getPublicSignups();

    // Un solo conteggio fallito (es. avvio a freddo del database oltre i 4 s), servito il ripiego.
    vi.advanceTimersByTime(server.PUBLIC_SIGNUPS_TTL_MS + 5_000);
    mocks.count.mockRejectedValueOnce(new Error('down'));
    expect(await server.getPublicSignups()).toMatchObject({ total: 4 });
    expect(errors).toHaveBeenCalledTimes(1);

    // Nessuna visita per 30 minuti; il database risponde di nuovo (lentamente, al risveglio).
    vi.advanceTimersByTime(30 * MINUTE_MS);
    const total = deferred<number>();
    const recent = deferred<number>();
    mocks.count.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      'createdAt' in where ? recent.promise : total.promise,
    );

    const pending = [server.getPublicSignups(), server.getPublicSignups()];
    const states = pending.map(track);
    await vi.advanceTimersByTimeAsync(0);
    // Il valore di 30 minuti fa non esce: nessuno lo riceve mentre il database risponde.
    expect(states.some((state) => state.settled)).toBe(false);
    expect(countPairs()).toBe(3);

    total.resolve(9);
    recent.resolve(5);
    for (const value of await Promise.all(pending)) {
      expect(value).toEqual({
        total: 9,
        last7Days: 5,
        updatedAt: new Date(Date.now()).toISOString(),
      });
    }
    expect(countPairs()).toBe(3);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('errore vecchio e il database ancora giù: chi aspetta riceve l’ultimo valore entro 4 secondi', async () => {
    db(4);
    await server.getPublicSignups();

    vi.advanceTimersByTime(server.PUBLIC_SIGNUPS_TTL_MS + 5_000);
    mocks.count.mockRejectedValueOnce(new Error('down'));
    await server.getPublicSignups();

    // Dopo 30 minuti senza visite il conteggio resta appeso: si aspetta, poi vale il ripiego.
    vi.advanceTimersByTime(30 * MINUTE_MS);
    mocks.count.mockImplementation(() => new Promise(() => {}));
    const pending = [server.getPublicSignups(), server.getPublicSignups()];
    const states = pending.map(track);
    await vi.advanceTimersByTimeAsync(server.PUBLIC_SIGNUPS_TIMEOUT_MS - 1);
    expect(states.some((state) => state.settled)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    for (const value of await Promise.all(pending)) {
      expect(value).toMatchObject({ total: 4, updatedAt: NOW.toISOString() });
    }
    expect(countPairs()).toBe(3);
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
