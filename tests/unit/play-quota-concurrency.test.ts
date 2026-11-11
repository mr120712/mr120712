// @polsia:user-owned — registrazione atomica degli ascolti Free: due richieste concorrenti non
// consumano due ascolti per lo stesso brano né superano insieme i 40 del mese.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tabella MusicPlay in memoria con transazioni Serializable simulate (come SSI di Postgres):
 * ogni transazione legge la fotografia presa all'inizio più le proprie scritture; al commit,
 * se un'altra transazione ha registrato righe dello stesso utente dopo il suo inizio e anche
 * lei scrive, fallisce con P2034 (vince chi fa commit per primo).
 */
const fake = vi.hoisted(() => {
  type Row = { userId: string; qualifiedId: string; month: string; createdAt: Date };
  type StartsWith = { qualifiedId: { startsWith: string } };
  type CountArgs = { where: { userId: string; month: string; NOT?: StartsWith | StartsWith[] } };
  type FindArgs = { where: { userId: string; qualifiedId: string; createdAt: { gt: Date } } };
  type Run = (transaction: unknown) => Promise<unknown>;

  const committed: Row[] = [];
  const commits: Array<{ seq: number; userIds: Set<string> }> = [];
  const log: Array<{ isolationLevel: unknown; outcome: 'committed' | 'serialization_failure' }> =
    [];
  let seq = 0;
  let barrier: { size: number; arrived: number; release: () => void; ready: Promise<void> } | null =
    null;

  /** The next `size` readers wait for each other after reading: they all see the same state. */
  function raceOn(size: number) {
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    barrier = { size, arrived: 0, release, ready };
  }

  async function arrive() {
    const current = barrier;
    if (!current) return;
    current.arrived += 1;
    if (current.arrived >= current.size) {
      barrier = null;
      current.release();
    }
    await current.ready;
  }

  function table(view: () => Row[], insert: (row: Row) => void, reads?: Set<string>) {
    return {
      count: async ({ where }: CountArgs) => {
        reads?.add(where.userId);
        const excluded = where.NOT ? [where.NOT].flat() : [];
        return view().filter(
          (row) =>
            row.userId === where.userId &&
            row.month === where.month &&
            !excluded.some((rule) => row.qualifiedId.startsWith(rule.qualifiedId.startsWith)),
        ).length;
      },
      findFirst: async ({ where }: FindArgs) => {
        reads?.add(where.userId);
        const found = view().find(
          (row) =>
            row.userId === where.userId &&
            row.qualifiedId === where.qualifiedId &&
            row.createdAt > where.createdAt.gt,
        );
        await arrive();
        return found ? { id: `${found.userId}/${found.qualifiedId}` } : null;
      },
      create: async ({ data }: { data: Row }) => {
        insert(data);
        return data;
      },
    };
  }

  async function serializableTransaction(run: Run, options?: { isolationLevel?: unknown }) {
    const startedAt = seq;
    const snapshot = [...committed];
    const pending: Row[] = [];
    const reads = new Set<string>();
    const result = await run({
      musicPlay: table(
        () => [...snapshot, ...pending],
        (row) => pending.push(row),
        reads,
      ),
    });
    const conflict =
      pending.length > 0 &&
      commits.some(
        (commit) =>
          commit.seq > startedAt && [...commit.userIds].some((userId) => reads.has(userId)),
      );
    log.push({
      isolationLevel: options?.isolationLevel,
      outcome: conflict ? 'serialization_failure' : 'committed',
    });
    if (conflict) {
      throw Object.assign(
        new Error('could not serialize access due to read/write dependencies among transactions'),
        { code: 'P2034' },
      );
    }
    if (pending.length > 0) {
      seq += 1;
      commits.push({ seq, userIds: new Set(pending.map((row) => row.userId)) });
      committed.push(...pending);
    }
    return result;
  }

  function reset() {
    committed.length = 0;
    commits.length = 0;
    log.length = 0;
    seq = 0;
    barrier = null;
  }

  return {
    committed,
    log,
    raceOn,
    reset,
    serializableTransaction,
    global: table(
      () => committed,
      (row) => committed.push(row),
    ),
    transaction: vi.fn(serializableTransaction),
    premium: vi.fn(async () => false),
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: fake.premium }));
vi.mock('@/lib/db', () => ({
  prisma: {
    musicPlay: fake.global,
    $transaction: (run: (transaction: unknown) => Promise<unknown>, options?: unknown) =>
      fake.transaction(run, options as { isolationLevel?: unknown }),
  },
}));

import { FREE_MONTHLY_PLAYS, REPLAY_WINDOW_MS, romeMonth } from '@/lib/business/play-quota';
import {
  consumePlay,
  PLAY_RECORD_ATTEMPTS,
  PlayQuotaUnavailableError,
} from '@/lib/business/play-quota.server';

const now = new Date('2026-11-20T10:00:00Z');
const user = { id: 'free-user' };

function fillQuota(userId: string, plays: number) {
  for (let i = 0; i < plays; i += 1) {
    fake.committed.push({
      userId,
      qualifiedId: `audius:old-${i}`,
      month: romeMonth(now),
      createdAt: new Date(now.getTime() - 2 * REPLAY_WINDOW_MS),
    });
  }
}

const rowsFor = (userId: string, qualifiedId?: string) =>
  fake.committed.filter(
    (row) => row.userId === userId && (!qualifiedId || row.qualifiedId === qualifiedId),
  );

const serializationFailure = () =>
  Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), {
    code: 'P2034',
  });

beforeEach(() => {
  fake.reset();
  fake.transaction.mockReset().mockImplementation(fake.serializableTransaction);
  fake.premium.mockReset().mockResolvedValue(false);
});

describe('consumePlay: letture e scrittura in una transazione Serializable', () => {
  it('due richieste concorrenti dello stesso brano (Range, prefetch + play) contano una volta', async () => {
    fake.raceOn(2);
    const decisions = await Promise.all([
      consumePlay(user, 'audius:track-71', now),
      consumePlay(user, 'audius:track-71', now),
    ]);

    expect(rowsFor(user.id, 'audius:track-71')).toHaveLength(1);
    expect(decisions).toContainEqual({
      allowed: true,
      counted: true,
      used: 1,
      limit: FREE_MONTHLY_PLAYS,
    });
    // The loser retried, saw the winner's row and took it as a replay: same shape as before.
    expect(decisions).toContainEqual({
      allowed: true,
      counted: false,
      used: 1,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(fake.log.map((entry) => entry.outcome)).toEqual([
      'committed',
      'serialization_failure',
      'committed',
    ]);
    expect(fake.log.every((entry) => entry.isolationLevel === 'Serializable')).toBe(true);
  });

  it('due brani diversi a 39/40: uno passa, l’altro riceve il blocco mensile', async () => {
    fillQuota(user.id, FREE_MONTHLY_PLAYS - 1);
    fake.raceOn(2);
    const decisions = await Promise.all([
      consumePlay(user, 'audius:last-free', now),
      consumePlay(user, 'podcast:123~episode-1', now),
    ]);

    expect(rowsFor(user.id)).toHaveLength(FREE_MONTHLY_PLAYS);
    expect(decisions).toContainEqual({
      allowed: true,
      counted: true,
      used: FREE_MONTHLY_PLAYS,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(decisions).toContainEqual({
      allowed: false,
      reason: 'monthly_limit',
      used: FREE_MONTHLY_PLAYS,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(fake.log.filter((entry) => entry.outcome === 'serialization_failure')).toHaveLength(1);
  });

  it('account diversi in parallelo non si intralciano', async () => {
    fillQuota('first', FREE_MONTHLY_PLAYS - 1);
    fillQuota('second', FREE_MONTHLY_PLAYS - 1);
    fake.raceOn(2);
    const [first, second] = await Promise.all([
      consumePlay({ id: 'first' }, 'audius:shared-track', now),
      consumePlay({ id: 'second' }, 'audius:shared-track', now),
    ]);

    expect(first).toEqual({
      allowed: true,
      counted: true,
      used: FREE_MONTHLY_PLAYS,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(second).toEqual(first);
    expect(fake.log.map((entry) => entry.outcome)).toEqual(['committed', 'committed']);
  });

  it('un conflitto risolto entro i tentativi registra l’ascolto una volta', async () => {
    fake.transaction
      .mockRejectedValueOnce(serializationFailure())
      .mockRejectedValueOnce(Object.assign(new Error('serialization_failure'), { code: '40001' }));

    expect(await consumePlay(user, 'audius:retry-track', now)).toEqual({
      allowed: true,
      counted: true,
      used: 1,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(fake.transaction).toHaveBeenCalledTimes(3);
    expect(rowsFor(user.id, 'audius:retry-track')).toHaveLength(1);
  });

  it.each([
    ['P2034', serializationFailure()],
    ['40001', Object.assign(new Error('serialization_failure'), { code: '40001' })],
    [
      'meta 40001',
      Object.assign(new Error('raw query failed'), { code: 'P2010', meta: { code: '40001' } }),
    ],
    [
      'messaggio Postgres',
      new Error(
        'PostgresError { code: "40001", message: "could not serialize access due to read/write dependencies among transactions" }',
      ),
    ],
  ])('conflitti oltre i tentativi (%s): errore controllato, nessuna riga', async (_name, error) => {
    fake.transaction.mockRejectedValue(error);

    const attempt = consumePlay(user, 'audius:busy-track', now);
    await expect(attempt).rejects.toBeInstanceOf(PlayQuotaUnavailableError);
    await expect(attempt).rejects.toHaveProperty('cause', error);
    expect(fake.transaction).toHaveBeenCalledTimes(PLAY_RECORD_ATTEMPTS);
    expect(fake.committed).toHaveLength(0);
  });

  it('un errore che non è di serializzazione non viene ritentato', async () => {
    const unreachable = Object.assign(new Error("Can't reach database server"), { code: 'P1001' });
    fake.transaction.mockRejectedValue(unreachable);

    await expect(consumePlay(user, 'audius:down-db', now)).rejects.toBe(unreachable);
    expect(fake.transaction).toHaveBeenCalledTimes(1);
    expect(fake.committed).toHaveLength(0);
  });

  it('Premium, YouTube, radio e ospiti non aprono transazioni né scrivono', async () => {
    fillQuota(user.id, FREE_MONTHLY_PLAYS);
    expect(await consumePlay(user, 'youtube:dQw4w9WgXcQ', now)).toEqual({
      allowed: true,
      counted: false,
      used: FREE_MONTHLY_PLAYS,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(await consumePlay(user, 'radio:station-71', now)).toEqual({
      allowed: true,
      counted: false,
      used: FREE_MONTHLY_PLAYS,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(await consumePlay(null, 'audius:guest-track', now)).toMatchObject({
      allowed: false,
      reason: 'login_required',
    });
    fake.premium.mockResolvedValue(true);
    expect(await consumePlay(user, 'audius:paid-track', now)).toEqual({
      allowed: true,
      counted: false,
      used: 0,
      limit: null,
    });

    expect(fake.transaction).not.toHaveBeenCalled();
    expect(rowsFor(user.id)).toHaveLength(FREE_MONTHLY_PLAYS);
  });
});
