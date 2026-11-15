// @polsia:user-owned — finto database in memoria per i test di audio.com: la riga unica
// AudioComConnection con findUnique / upsert / updateMany. updateMany applica le condizioni come
// l'UPDATE … WHERE del database (id, tokenVersion, OR su refreshLockedUntil) e gli incrementi; ogni
// payload scritto resta registrato, così i test verificano che nessun token sia salvato in chiaro.

export type FakeAudioComRow = {
  id: string;
  clientId: string | null;
  redirectUri: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  scope: string | null;
  accountName: string | null;
  connectedAt: Date | null;
  tokenVersion: number;
  refreshLockedUntil: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type LockCondition = { refreshLockedUntil: null } | { refreshLockedUntil: { lt: Date } };
type Where = { id: string; tokenVersion?: number; OR?: LockCondition[] };
type Data = Record<string, unknown>;

function emptyRow(id: string): FakeAudioComRow {
  const now = new Date();
  return {
    id,
    clientId: null,
    redirectUri: null,
    accessToken: null,
    refreshToken: null,
    accessExpiresAt: null,
    scope: null,
    accountName: null,
    connectedAt: null,
    tokenVersion: 0,
    refreshLockedUntil: null,
    lastError: null,
    lastErrorAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function matchesLock(row: FakeAudioComRow, condition: LockCondition): boolean {
  const value = condition.refreshLockedUntil;
  if (value === null) return row.refreshLockedUntil === null;
  return row.refreshLockedUntil !== null && row.refreshLockedUntil < value.lt;
}

function matches(row: FakeAudioComRow, where: Where): boolean {
  if (row.id !== where.id) return false;
  if (where.tokenVersion !== undefined && row.tokenVersion !== where.tokenVersion) return false;
  if (where.OR && !where.OR.some((condition) => matchesLock(row, condition))) return false;
  return true;
}

function apply(row: FakeAudioComRow, data: Data): void {
  const target = row as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) {
      target[key] = Number(target[key] ?? 0) + Number((value as { increment: number }).increment);
    } else {
      target[key] = value;
    }
  }
  row.updatedAt = new Date();
}

export function createAudioComDbFake() {
  const state = { row: null as FakeAudioComRow | null };
  /** Ogni payload scritto (create/update/data), per cercare token in chiaro. */
  const writes: unknown[] = [];
  const calls = { findUnique: 0, upsert: 0, updateMany: 0 };

  const audioComConnection = {
    async findUnique({ where }: { where: { id: string } }) {
      calls.findUnique += 1;
      if (!state.row || state.row.id !== where.id) return null;
      return { ...state.row };
    },
    async upsert({ where, create, update }: { where: { id: string }; create: Data; update: Data }) {
      calls.upsert += 1;
      if (state.row && state.row.id === where.id) {
        writes.push(update);
        apply(state.row, update);
      } else {
        writes.push(create);
        const row = emptyRow(where.id);
        apply(row, create);
        state.row = row;
      }
      return { ...state.row };
    },
    async updateMany({ where, data }: { where: Where; data: Data }) {
      calls.updateMany += 1;
      writes.push(data);
      if (!state.row || !matches(state.row, where)) return { count: 0 };
      apply(state.row, data);
      return { count: 1 };
    },
  };

  return {
    prisma: { audioComConnection },
    state,
    writes,
    calls,
    /** Mette una riga direttamente (stato di partenza di un test). */
    seed(row: Partial<FakeAudioComRow>) {
      state.row = { ...emptyRow('audiocom'), ...row };
    },
    reset() {
      state.row = null;
      writes.length = 0;
      calls.findUnique = 0;
      calls.upsert = 0;
      calls.updateMany = 0;
    },
  };
}

/** Istanza condivisa: il mock di '@/lib/db' e il test leggono la stessa riga. */
export const sharedAudioComDb = createAudioComDbFake();
