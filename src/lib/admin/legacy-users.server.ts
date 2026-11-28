// @polsia:user-owned — «Utenti del vecchio sito» (/admin/utenti-vecchi): controllo dei database
// indicati dalle variabili d'ambiente, anteprima e trasferimento degli account nel database attuale.
// Le regole pure (fonti, raggruppamento, piano, gettone) sono in legacy-users.ts.
//
// Vecchio database: SOLO lettura, e solo quando l'admin lo chiede. Un PrismaClient separato per
// ogni database (una connessione, timeout brevi, TLS obbligatorio), transazione READ ONLY con
// statement_timeout di 8 secondi, una scadenza complessiva, e $disconnect sempre nel finally. Si
// leggono solo "user" e "account" di better-auth (senza i token OAuth, tolti già nella query) e il
// numero di righe delle altre tabelle, per informazione.
//
// Database attuale: si scrivono solo righe NUOVE in "user", "account" e LegacyUserImport, a lotti
// in una transazione. Nessuna riga esistente viene modificata: chi ha già un account con la stessa
// email (maiuscole a parte) resta com'è e il vecchio account viene saltato.
//
// Fuori da qui escono solo conteggi, nomi di variabili, impronte opache e categorie di errore. Nei
// log va solo il nome dell'errore: mai URL, host, email, hash o il testo del driver.
import 'server-only';
import { type Prisma, PrismaClient } from '@prisma/client';
import {
  buildLegacyPlan,
  type CurrentState,
  errorName,
  groupLegacySources,
  LegacyDeadlineError,
  type LegacyErrorKind,
  type LegacyPlan,
  type LegacySnapshot,
  LegacyTooLargeError,
  legacyErrorKind,
  lookupKeys,
  oauthKey,
  type PlannedUser,
  parseLegacyAccount,
  parseLegacyUser,
  previewCovers,
  randomId,
  reservedAdminIdentities,
  type SourceGroup,
  signPreviewToken,
  verifyPreviewToken,
} from '@/lib/admin/legacy-users';
import { isPhoneAccountEmail } from '@/lib/business/phone-auth';
import type {
  LegacyDbGroup,
  LegacyImportResponse,
  LegacyPreviewResponse,
  LegacyTable,
  LegacyUsersDiagnostic,
} from '@/lib/contracts/legacy-users';
import { prisma } from '@/lib/db';

/** Account creati a ogni richiesta («Continua»): resta lontano dai limiti di tempo di Vercel. */
export const LEGACY_IMPORT_BATCH_SIZE = 200;
/** Oltre questo numero di utenti la lettura in una sola richiesta non è prudente. */
export const MAX_LEGACY_USERS = 20_000;
const MAX_LEGACY_ACCOUNTS = 60_000;
const MAX_OTHER_TABLES = 60;
/** Scadenza complessiva di tutte le letture su un vecchio database. */
export const LEGACY_DEADLINE_MS = 25_000;
const LEGACY_TX_OPTIONS = { maxWait: 5_000, timeout: 20_000 };
const IMPORT_TX_OPTIONS = { maxWait: 5_000, timeout: 20_000 };
const LOOKUP_CHUNK = 1_000;
const CREDENTIAL_PROVIDER = 'credential';

const REQUIRED_USER_COLUMNS = ['id', 'email', 'emailVerified', 'createdAt'];
const REQUIRED_ACCOUNT_COLUMNS = ['userId', 'providerId', 'accountId'];
/** Tabelle utenti di altri sistemi: segnalate, mai trasferite automaticamente. */
const OTHER_USER_TABLES = [
  'users',
  'User',
  'Users',
  'auth_users',
  'auth_user',
  'profiles',
  'members',
];

export type LegacyFailure =
  | { code: 'secret_missing' }
  | { code: 'unknown_source' }
  | { code: 'source_in_use' }
  | { code: 'source_incomplete' }
  | { code: 'source_incompatible' }
  | { code: 'source_unavailable'; kind: LegacyErrorKind }
  | { code: 'preview_invalid' }
  | { code: 'preview_expired' }
  | { code: 'preview_mismatch' };

export type LegacyResult<T> = { ok: true; value: T } | { ok: false; failure: LegacyFailure };

export type LegacyOptions = {
  env?: Record<string, string | undefined>;
  now?: Date;
  batchSize?: number;
};

function ok<T>(value: T): LegacyResult<T> {
  return { ok: true, value };
}

function fail<T>(failure: LegacyFailure): LegacyResult<T> {
  return { ok: false, failure };
}

function logFailure(stage: string, error: unknown) {
  // Solo il nome dell'errore: il messaggio del driver può contenere host e utente.
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
  console.error(`[admin/legacy-users] ${stage} non riuscito:`, errorName(error));
}

// ---------------------------------------------------------------------------------------------
// Vecchio database: client separato, sola lettura
// ---------------------------------------------------------------------------------------------

/** Apre un client per un vecchio database, applica la scadenza e lo chiude SEMPRE. */
async function withLegacyClient<T>(url: string, run: (client: PrismaClient) => Promise<T>) {
  // Never open legacy database connections from Vercel previews or development.
  if (process.env.VERCEL === '1' && process.env.VERCEL_ENV !== 'production') {
    throw new Error('Legacy database access is disabled outside production.');
  }
  const client = new PrismaClient({ datasourceUrl: url, log: [] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LegacyDeadlineError()), LEGACY_DEADLINE_MS);
  });
  try {
    return await Promise.race([run(client), deadline]);
  } finally {
    clearTimeout(timer);
    await client.$disconnect().catch(() => undefined);
  }
}

/** Transazione READ ONLY con statement_timeout di 8 secondi (SET LOCAL: vale solo qui dentro). */
function readOnly<T>(client: PrismaClient, run: (tx: Prisma.TransactionClient) => Promise<T>) {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = 8000`;
    return run(tx);
  }, LEGACY_TX_OPTIONS);
}

type LegacyRead =
  | { kind: 'ok'; snapshot: LegacySnapshot }
  | { kind: 'incompatible'; otherUsersTable: string | null };

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

/** Tabelle, colonne e righe di "user" e "account" (senza token OAuth). */
async function readLegacyData(tx: Prisma.TransactionClient): Promise<LegacyRead> {
  const tables = await tx.$queryRaw<Array<{ name: string }>>`
    SELECT table_name::text AS name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    ORDER BY table_name
    LIMIT 500`;
  const names = new Set(tables.map((row) => row.name));
  if (!names.has('user') || !names.has('account')) {
    return {
      kind: 'incompatible',
      otherUsersTable: OTHER_USER_TABLES.find((table) => names.has(table)) ?? null,
    };
  }
  const columns = await tx.$queryRaw<Array<{ table: string; column: string }>>`
    SELECT table_name::text AS "table", column_name::text AS "column"
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name IN ('user', 'account')`;
  const userColumns = new Set(columns.filter((c) => c.table === 'user').map((c) => c.column));
  const accountColumns = new Set(columns.filter((c) => c.table === 'account').map((c) => c.column));
  if (
    !REQUIRED_USER_COLUMNS.every((column) => userColumns.has(column)) ||
    !REQUIRED_ACCOUNT_COLUMNS.every((column) => accountColumns.has(column))
  ) {
    return { kind: 'incompatible', otherUsersTable: null };
  }

  // to_jsonb: le colonne facoltative (telefono, blocco, ruolo…) ci sono solo se esistono, senza
  // costruire SQL dinamico.
  const userRows = await tx.$queryRaw<Array<{ data: unknown }>>`
    SELECT to_jsonb(u) AS data FROM "user" AS u LIMIT ${MAX_LEGACY_USERS + 1}`;
  if (userRows.length > MAX_LEGACY_USERS) throw new LegacyTooLargeError();
  // I token OAuth non lasciano mai il vecchio database: tolti dentro la query.
  const accountRows = await tx.$queryRaw<Array<{ data: unknown }>>`
    SELECT (to_jsonb(a) - 'accessToken' - 'refreshToken' - 'idToken') AS data
    FROM "account" AS a
    LIMIT ${MAX_LEGACY_ACCOUNTS + 1}`;
  if (accountRows.length > MAX_LEGACY_ACCOUNTS) throw new LegacyTooLargeError();

  const users = userRows.map((row) => parseLegacyUser(row.data)).filter(nonNull);
  const userIds = new Set(users.map((user) => user.id));
  const accounts = accountRows
    .map((row) => parseLegacyAccount(row.data))
    .filter(nonNull)
    .filter((account) => userIds.has(account.userId));
  return { kind: 'ok', snapshot: { users, accounts } };
}

function toCount(value: unknown): number | null {
  if (typeof value === 'bigint') return value >= 0n ? Number(value) : 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  return null;
}

function tableRows(rows: Array<{ name: string; rows: unknown }>): LegacyTable[] {
  return rows
    .filter((row) => typeof row.name === 'string' && row.name.length > 0)
    .map((row) => ({ name: row.name.slice(0, 128), rows: toCount(row.rows) }));
}

/**
 * Altre tabelle del vecchio database con il numero di righe, solo per informazione. Conteggio
 * esatto con un'unica query statica (query_to_xml + format %I quota i nomi); se non riesce entro
 * il timeout, la stima di Postgres (pg_class.reltuples).
 */
async function countOtherTables(
  client: PrismaClient,
): Promise<{ tables: LegacyTable[]; approximate: boolean }> {
  try {
    const rows = await readOnly(
      client,
      (tx) => tx.$queryRaw<Array<{ name: string; rows: unknown }>>`
        SELECT t.table_name::text AS name,
          (xpath('/row/c/text()', query_to_xml(
            format('SELECT count(*) AS c FROM %I.%I', t.table_schema::text, t.table_name::text),
            false, true, ''
          )))[1]::text::bigint AS rows
        FROM information_schema.tables AS t
        WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
          AND t.table_name NOT IN ('user', 'account', 'session', 'verification', '_prisma_migrations')
        ORDER BY t.table_name
        LIMIT ${MAX_OTHER_TABLES}`,
    );
    return { tables: tableRows(rows), approximate: false };
  } catch (error) {
    if (error instanceof LegacyDeadlineError) throw error;
    try {
      const rows = await readOnly(
        client,
        (tx) => tx.$queryRaw<Array<{ name: string; rows: unknown }>>`
          SELECT c.relname::text AS name, GREATEST(c.reltuples, 0)::bigint AS rows
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
            AND c.relname NOT IN ('user', 'account', 'session', 'verification', '_prisma_migrations')
          ORDER BY c.relname
          LIMIT ${MAX_OTHER_TABLES}`,
      );
      return { tables: tableRows(rows), approximate: true };
    } catch {
      return { tables: [], approximate: true };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Database attuale: confronto in memoria (le email non escono mai dal server)
// ---------------------------------------------------------------------------------------------

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += LOOKUP_CHUNK) {
    out.push(list.slice(index, index + LOOKUP_CHUNK));
  }
  return out;
}

async function collect(values: readonly string[], find: (chunk: string[]) => Promise<string[]>) {
  const found = new Set<string>();
  for (const chunk of chunks(values)) for (const value of await find(chunk)) found.add(value);
  return found;
}

type Reserved = ReturnType<typeof reservedAdminIdentities>;

async function loadCurrentState(
  snapshot: LegacySnapshot,
  reserved: Reserved,
): Promise<CurrentState> {
  const keys = lookupKeys(snapshot);
  const legacyIds = [...new Set(snapshot.users.map((user) => user.id))];
  const [existingEmails, takenIds, takenPhones, takenOAuth, importedLegacyIds] = await Promise.all([
    collect(keys.emails, async (chunk) => {
      const rows = await prisma.user.findMany({
        where: { email: { in: chunk, mode: 'insensitive' } },
        select: { email: true },
      });
      return rows.map((row) => row.email.trim().toLowerCase());
    }),
    collect(keys.ids, async (chunk) => {
      const rows = await prisma.user.findMany({
        where: { id: { in: chunk } },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }),
    collect(keys.phones, async (chunk) => {
      const rows = await prisma.user.findMany({
        where: { phoneNumber: { in: chunk } },
        select: { phoneNumber: true },
      });
      return rows.flatMap((row) => (row.phoneNumber ? [row.phoneNumber] : []));
    }),
    collect(keys.accountIds, async (chunk) => {
      const rows = await prisma.account.findMany({
        where: { accountId: { in: chunk } },
        select: { providerId: true, accountId: true },
      });
      return rows.map((row) => oauthKey(row.providerId, row.accountId));
    }),
    // Da QUALSIASI fonte: lo stesso vecchio database raggiunto con un altro utente (o dopo un
    // cambio di BETTER_AUTH_SECRET) ha un'altra impronta, ma gli account sono gli stessi. Così un
    // account cancellato qui, o che qui ha cambiato email, non viene ricreato.
    collect(legacyIds, async (chunk) => {
      const rows = await prisma.legacyUserImport.findMany({
        where: { legacyUserId: { in: chunk } },
        select: { legacyUserId: true },
      });
      return rows.map((row) => row.legacyUserId);
    }),
  ]);
  return {
    existingEmails,
    takenIds,
    takenPhones,
    takenOAuth,
    importedLegacyIds,
    reservedEmails: reserved.emails,
    reservedIds: reserved.ids,
  };
}

// ---------------------------------------------------------------------------------------------
// Controllo dei database
// ---------------------------------------------------------------------------------------------

function secretFrom(env: Record<string, string | undefined>): string | null {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  return secret ? secret : null;
}

async function diagnoseGroup(
  group: SourceGroup,
  now: Date,
  reserved: Reserved,
): Promise<LegacyDbGroup> {
  const base: Omit<LegacyDbGroup, 'status'> = {
    source: group.key,
    current: group.current,
    providerHint: group.providerHint,
    envVars: group.envNames,
    incompleteVars: group.incompleteLabels,
    errorKind: null,
    currentUsers: null,
    otherUsersTable: null,
    stats: null,
    otherTables: [],
    otherTablesApproximate: false,
  };
  if (group.current) {
    // Il database in uso non si apre con un client separato: basta il conteggio degli utenti.
    const currentUsers = await prisma.user.count().catch((error: unknown) => {
      logFailure('conteggio utenti del database in uso', error);
      return null;
    });
    return { ...base, status: 'current', currentUsers };
  }
  if (!group.connectionUrl) return { ...base, status: 'incomplete' };

  let read: { data: LegacyRead; tables: { tables: LegacyTable[]; approximate: boolean } };
  try {
    read = await withLegacyClient(group.connectionUrl, async (client) => {
      const data = await readOnly(client, readLegacyData);
      const tables = await countOtherTables(client);
      return { data, tables };
    });
  } catch (error) {
    logFailure('controllo di un vecchio database', error);
    return { ...base, status: 'error', errorKind: legacyErrorKind(error) };
  }
  const withTables = {
    ...base,
    otherTables: read.tables.tables,
    otherTablesApproximate: read.tables.approximate,
  };
  if (read.data.kind === 'incompatible') {
    return { ...withTables, status: 'incompatible', otherUsersTable: read.data.otherUsersTable };
  }
  // Un errore del database ATTUALE non è colpa del vecchio: risale alla route (500).
  const state = await loadCurrentState(read.data.snapshot, reserved);
  const plan = buildLegacyPlan(read.data.snapshot, state, now);
  return { ...withTables, status: 'ready', stats: plan.counts };
}

/** Controlla ogni database trovato nelle variabili (in parallelo, ognuno col suo client). */
export async function diagnoseLegacyUsers(
  options: LegacyOptions = {},
): Promise<LegacyResult<LegacyUsersDiagnostic>> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const secret = secretFrom(env);
  if (!secret) return fail({ code: 'secret_missing' });
  const discovery = groupLegacySources(env, secret);
  const reserved = reservedAdminIdentities(env);
  const groups = await Promise.all(
    discovery.groups.map((group) => diagnoseGroup(group, now, reserved)),
  );
  return ok({
    generatedAt: now.toISOString(),
    batchSize: options.batchSize ?? LEGACY_IMPORT_BATCH_SIZE,
    currentDetected: discovery.currentDetected,
    groups,
    skippedVars: discovery.skipped,
  });
}

// ---------------------------------------------------------------------------------------------
// Anteprima e trasferimento
// ---------------------------------------------------------------------------------------------

function resolveGroup(
  source: string,
  env: Record<string, string | undefined>,
  secret: string,
): LegacyResult<SourceGroup> {
  const group = groupLegacySources(env, secret).groups.find((item) => item.key === source);
  if (!group) return fail({ code: 'unknown_source' });
  if (group.current) return fail({ code: 'source_in_use' });
  if (!group.connectionUrl) return fail({ code: 'source_incomplete' });
  return ok(group);
}

/** Legge il vecchio database e calcola il piano esatto rispetto al database attuale. */
async function loadPlan(
  group: SourceGroup,
  now: Date,
  reserved: Reserved,
): Promise<LegacyResult<LegacyPlan>> {
  const url = group.connectionUrl;
  if (!url) return fail({ code: 'source_incomplete' });
  let data: LegacyRead;
  try {
    data = await withLegacyClient(url, (client) => readOnly(client, readLegacyData));
  } catch (error) {
    logFailure('lettura di un vecchio database', error);
    return fail({ code: 'source_unavailable', kind: legacyErrorKind(error) });
  }
  if (data.kind === 'incompatible') return fail({ code: 'source_incompatible' });
  const state = await loadCurrentState(data.snapshot, reserved);
  return ok(buildLegacyPlan(data.snapshot, state, now));
}

/** Piano del trasferimento + gettone firmato (15 minuti). Non scrive nulla. */
export async function previewLegacyImport(
  source: string,
  options: LegacyOptions = {},
): Promise<LegacyResult<LegacyPreviewResponse>> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const secret = secretFrom(env);
  if (!secret) return fail({ code: 'secret_missing' });
  const group = resolveGroup(source, env, secret);
  if (!group.ok) return group;
  const plan = await loadPlan(group.value, now, reservedAdminIdentities(env));
  if (!plan.ok) return plan;
  const ids = plan.value.toImport.map((planned) => planned.legacyId);
  const signed =
    ids.length > 0
      ? signPreviewToken({ sourceKey: source, ids, secret, now: now.getTime() })
      : null;
  return ok({
    action: 'preview',
    source,
    stats: plan.value.counts,
    previewToken: signed?.token ?? null,
    expiresAt: signed?.expiresAt ?? null,
    batchSize: options.batchSize ?? LEGACY_IMPORT_BATCH_SIZE,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Crea utenti, collegamenti e righe del registro in UNA transazione. Prima ricontrolla, dentro la
 * transazione, email, id, telefoni, collegamenti OAuth e trasferimenti (da qualsiasi fonte)
 * comparsi nel frattempo: chi è stato preceduto viene saltato (conflitto), mai unito. Le identità
 * che il sito promuove ad admin da solo non vengono mai create (email) né riusate (id).
 */
async function insertPlanned(
  tx: Prisma.TransactionClient,
  batch: readonly PlannedUser[],
  sourceKey: string,
  now: Date,
  reserved: Reserved,
): Promise<{ imported: number; conflicts: number }> {
  const emailRows = await tx.user.findMany({
    where: { email: { in: batch.map((p) => p.user.email), mode: 'insensitive' } },
    select: { email: true },
  });
  const takenEmails = new Set(emailRows.map((row) => row.email.trim().toLowerCase()));
  const doneRows = await tx.legacyUserImport.findMany({
    where: { legacyUserId: { in: batch.map((p) => p.legacyId) } },
    select: { legacyUserId: true },
  });
  const done = new Set(doneRows.map((row) => row.legacyUserId));
  const idRows = await tx.user.findMany({
    where: { id: { in: batch.map((p) => p.user.id) } },
    select: { id: true },
  });
  const takenIds = new Set(idRows.map((row) => row.id));
  const phones = batch.flatMap((p) => (p.user.phoneNumber ? [p.user.phoneNumber] : []));
  const phoneRows = phones.length
    ? await tx.user.findMany({
        where: { phoneNumber: { in: phones } },
        select: { phoneNumber: true },
      })
    : [];
  const takenPhones = new Set(
    phoneRows.flatMap((row) => (row.phoneNumber ? [row.phoneNumber] : [])),
  );
  const oauthIds = batch.flatMap((p) =>
    p.accounts.flatMap((a) =>
      a.providerId !== CREDENTIAL_PROVIDER && a.accountId ? [a.accountId] : [],
    ),
  );
  const oauthRows = oauthIds.length
    ? await tx.account.findMany({
        where: { accountId: { in: oauthIds } },
        select: { providerId: true, accountId: true },
      })
    : [];
  const takenOAuth = new Set(oauthRows.map((row) => oauthKey(row.providerId, row.accountId)));

  const users: Prisma.UserCreateManyInput[] = [];
  const accounts: Prisma.AccountCreateManyInput[] = [];
  const records: Prisma.LegacyUserImportCreateManyInput[] = [];
  for (const planned of batch) {
    if (
      takenEmails.has(planned.user.email) ||
      reserved.emails.has(planned.user.email) ||
      done.has(planned.legacyId)
    ) {
      continue;
    }
    const phone =
      planned.user.phoneNumber && !takenPhones.has(planned.user.phoneNumber)
        ? planned.user.phoneNumber
        : null;
    // Email provvisoria del telefono e numero preso nel frattempo: nessun modo di accedere.
    if (!phone && isPhoneAccountEmail(planned.user.email)) continue;
    const id =
      takenIds.has(planned.user.id) || reserved.ids.has(planned.user.id)
        ? randomId()
        : planned.user.id;
    users.push({
      ...planned.user,
      id,
      role: 'user',
      phoneNumber: phone,
      phoneNumberVerified: phone ? true : null,
    });
    for (const account of planned.accounts) {
      const isCredential = account.providerId === CREDENTIAL_PROVIDER;
      if (!isCredential && takenOAuth.has(oauthKey(account.providerId, account.accountId ?? ''))) {
        continue;
      }
      accounts.push({
        id: randomId(),
        userId: id,
        providerId: account.providerId,
        // Come better-auth: la credenziale ha accountId = id dell'utente.
        accountId: isCredential ? id : (account.accountId ?? id),
        password: isCredential ? account.password : null,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      });
    }
    records.push({ sourceKey, legacyUserId: planned.legacyId, userId: id, importedAt: now });
  }
  if (users.length > 0) {
    await tx.user.createMany({ data: users });
    if (accounts.length > 0) await tx.account.createMany({ data: accounts });
    await tx.legacyUserImport.createMany({ data: records });
  }
  return { imported: users.length, conflicts: batch.length - users.length };
}

/** Un lotto in una transazione; se qualcuno si iscrive nel frattempo, uno alla volta. */
async function insertBatch(
  batch: readonly PlannedUser[],
  sourceKey: string,
  now: Date,
  reserved: Reserved,
) {
  if (batch.length === 0) return { imported: 0, conflicts: 0 };
  try {
    return await prisma.$transaction(
      (tx) => insertPlanned(tx, batch, sourceKey, now, reserved),
      IMPORT_TX_OPTIONS,
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  let imported = 0;
  let conflicts = 0;
  for (const planned of batch) {
    try {
      const result = await prisma.$transaction(
        (tx) => insertPlanned(tx, [planned], sourceKey, now, reserved),
        IMPORT_TX_OPTIONS,
      );
      imported += result.imported;
      conflicts += result.conflicts;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      conflicts += 1;
    }
  }
  return { imported, conflicts };
}

/**
 * Un lotto del trasferimento. Il gettone dell'anteprima deve essere valido e il piano ricalcolato
 * non può contenere utenti che l'anteprima non aveva (un piano più piccolo va bene).
 */
export async function importLegacyBatch(
  source: string,
  previewToken: string,
  options: LegacyOptions = {},
): Promise<LegacyResult<LegacyImportResponse>> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? LEGACY_IMPORT_BATCH_SIZE;
  const secret = secretFrom(env);
  if (!secret) return fail({ code: 'secret_missing' });
  const verified = verifyPreviewToken(previewToken, {
    sourceKey: source,
    secret,
    now: now.getTime(),
  });
  if (!verified.ok) {
    return fail({ code: verified.reason === 'expired' ? 'preview_expired' : 'preview_invalid' });
  }
  const group = resolveGroup(source, env, secret);
  if (!group.ok) return group;
  const reserved = reservedAdminIdentities(env);
  const plan = await loadPlan(group.value, now, reserved);
  if (!plan.ok) return plan;
  const ids = plan.value.toImport.map((planned) => planned.legacyId);
  if (!previewCovers(verified.preview, ids, secret)) return fail({ code: 'preview_mismatch' });

  const batch = plan.value.toImport.slice(0, batchSize);
  const { imported, conflicts } = await insertBatch(batch, source, now, reserved);
  const totalImported = await prisma.legacyUserImport.count({ where: { sourceKey: source } });
  const remaining = Math.max(0, plan.value.toImport.length - batch.length);
  const { counts } = plan.value;
  return ok({
    action: 'import',
    source,
    batch: {
      imported,
      conflicts,
      skippedExisting: counts.alreadyPresent + counts.duplicateInSource,
      skippedInvalidEmail: counts.invalidEmail,
      totalImported,
      remaining,
      done: remaining === 0,
    },
  });
}
