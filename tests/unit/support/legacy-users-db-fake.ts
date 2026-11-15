// @polsia:user-owned — database attuale finto per i test di «Utenti del vecchio sito»: tabelle
// "user", "account" e LegacyUserImport in memoria, con i vincoli unici veri (email, id,
// sourceKey+legacyUserId → errore P2002) e transazioni che annullano tutto in caso di errore.

export type FakeUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | null;
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

export type FakeAccount = {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  password?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type FakeImport = {
  id?: string;
  sourceKey: string;
  legacyUserId: string;
  userId: string;
  importedAt?: Date;
};

type InFilter = { in?: string[]; mode?: 'insensitive' };

function uniqueError() {
  return Object.assign(new Error('Unique constraint failed'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2002',
  });
}

function matches(value: string | null | undefined, filter: InFilter | undefined): boolean {
  if (!filter?.in) return true;
  if (value === null || value === undefined) return false;
  if (filter.mode === 'insensitive') {
    const lower = filter.in.map((item) => item.toLowerCase());
    return lower.includes(value.toLowerCase());
  }
  return filter.in.includes(value);
}

function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

export function createLegacyCurrentDb(
  initial: { users?: FakeUser[]; accounts?: FakeAccount[] } = {},
) {
  const tables = {
    users: [...(initial.users ?? [])],
    accounts: [...(initial.accounts ?? [])],
    imports: [] as FakeImport[],
  };
  /**
   * Iscrizioni concorrenti: alla prossima createMany di "user" l'utente indicato viene salvato da
   * un'ALTRA connessione (resta anche se questa transazione viene annullata) e la scrittura fallisce
   * col vincolo unico, come farebbe Postgres.
   */
  const concurrentSignups: FakeUser[] = [];
  const committedElsewhere: FakeUser[] = [];

  const db = {
    user: {
      findMany: async ({
        where,
        select,
      }: {
        where: { email?: InFilter; id?: InFilter; phoneNumber?: InFilter };
        select?: Record<string, boolean>;
      }) =>
        tables.users
          .filter(
            (user) =>
              matches(user.email, where.email) &&
              matches(user.id, where.id) &&
              matches(user.phoneNumber, where.phoneNumber),
          )
          .map((user) => pick(user, select)),
      createMany: async ({ data }: { data: FakeUser[] }) => {
        const concurrent = concurrentSignups.shift();
        if (concurrent) {
          committedElsewhere.push(concurrent);
          throw uniqueError();
        }
        for (const row of data) {
          if (tables.users.some((user) => user.id === row.id || user.email === row.email)) {
            throw uniqueError();
          }
          tables.users.push({ ...row });
        }
        return { count: data.length };
      },
      count: async () => tables.users.length,
    },
    account: {
      findMany: async ({
        where,
        select,
      }: {
        where: { accountId?: InFilter };
        select?: Record<string, boolean>;
      }) =>
        tables.accounts
          .filter((account) => matches(account.accountId, where.accountId))
          .map((account) => pick(account, select)),
      createMany: async ({ data }: { data: FakeAccount[] }) => {
        for (const row of data) {
          if (tables.accounts.some((account) => account.id === row.id)) throw uniqueError();
          tables.accounts.push({ ...row });
        }
        return { count: data.length };
      },
    },
    legacyUserImport: {
      findMany: async ({
        where,
        select,
      }: {
        where: { sourceKey?: string; legacyUserId?: InFilter };
        select?: Record<string, boolean>;
      }) =>
        tables.imports
          .filter(
            (row) =>
              (where.sourceKey === undefined || row.sourceKey === where.sourceKey) &&
              matches(row.legacyUserId, where.legacyUserId),
          )
          .map((row) => pick(row, select)),
      createMany: async ({ data }: { data: FakeImport[] }) => {
        for (const row of data) {
          if (
            tables.imports.some(
              (item) => item.sourceKey === row.sourceKey && item.legacyUserId === row.legacyUserId,
            )
          ) {
            throw uniqueError();
          }
          tables.imports.push({ ...row });
        }
        return { count: data.length };
      },
      count: async ({ where }: { where: { sourceKey: string } }) =>
        tables.imports.filter((row) => row.sourceKey === where.sourceKey).length,
    },
    $transaction: async <T>(run: (tx: unknown) => Promise<T>) => {
      const saved = {
        users: [...tables.users],
        accounts: [...tables.accounts],
        imports: [...tables.imports],
      };
      try {
        return await run(db);
      } catch (error) {
        tables.users = saved.users;
        tables.accounts = saved.accounts;
        tables.imports = saved.imports;
        tables.users.push(...committedElsewhere.splice(0));
        throw error;
      }
    },
  };

  return { db, tables, concurrentSignups };
}
