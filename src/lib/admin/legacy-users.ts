// @polsia:user-owned — regole pure (nessun I/O di rete o database) per «Utenti del vecchio sito»
// (/admin/utenti-vecchi): quali variabili d'ambiente possono indicare un database, come capire
// che due variabili puntano allo STESSO database, come riconoscere il fornitore senza mostrare
// l'host, la compatibilità delle password, il piano di trasferimento degli account e il gettone
// firmato dell'anteprima. Il modulo server (legacy-users.server.ts) fa le connessioni e le scritture.
//
// Sicurezza:
//   - le variabili lette sono SOLO quelle di un elenco fisso (mai un nome scelto dall'utente);
//   - URL, host, utente e password restano in memoria sul server: fuori escono solo nomi di
//     variabili, un'impronta opaca (HMAC) del database e un'indicazione generica del fornitore;
//   - non si inventano credenziali: un gruppo di variabili senza password è «incompleto»;
//   - il piano non copia mai il ruolo admin, i token OAuth, le sessioni o le password in un formato
//     che l'accesso attuale non sa verificare.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { REQUESTED_ADMIN_EMAIL } from '@/lib/business/admin-account-policy';
import { isPhoneAccountEmail, isValidE164, phoneAccountName } from '@/lib/business/phone-auth';

// ---------------------------------------------------------------------------------------------
// Fonti: elenco fisso delle variabili d'ambiente
// ---------------------------------------------------------------------------------------------

/**
 * Variabili con una stringa di connessione completa, nell'ordine di preferenza a parità di
 * database (il vecchio sito prima, poi le integrazioni Neon/Vercel). DATABASE_URL è il database in
 * uso: serve a riconoscerlo e a non importare mai da lì.
 */
export const LEGACY_URL_ENV_NAMES = [
  'OLD_DATABASE_URL',
  'LEGACY_DATABASE_URL',
  'SOLCO_DATABASE_URL_UNPOOLED',
  'SOLCO_POSTGRES_URL_NON_POOLING',
  'SOLCO_DATABASE_URL',
  'SOLCO_POSTGRES_URL',
  'SOLCO_POSTGRES_PRISMA_URL',
  'SOLCO_POSTGRES_URL_NO_SSL',
  'MY_SOLCO_DATABASE_URL',
  'MY_SOLCO_POSTGRES_URL',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'DATABASE_URL_POOLED',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NO_SSL',
] as const;

type ComponentSet = {
  /** Etichetta mostrata all'admin quando il gruppo è incompleto. */
  label: string;
  /** Host in ordine di preferenza (prima quello diretto, senza pooler). */
  hosts: readonly string[];
  user: string;
  password: string;
  database: string;
  port: string;
  sslmode: string;
};

/** Gruppi di variabili "a pezzi" (host, utente, password, database) creati dalle integrazioni. */
export const LEGACY_COMPONENT_SETS: readonly ComponentSet[] = [
  {
    label: 'SOLCO_PG*',
    hosts: ['SOLCO_PGHOST_UNPOOLED', 'SOLCO_PGHOST'],
    user: 'SOLCO_PGUSER',
    password: 'SOLCO_PGPASSWORD',
    database: 'SOLCO_PGDATABASE',
    port: 'SOLCO_PGPORT',
    sslmode: 'SOLCO_PGSSLMODE',
  },
  {
    label: 'MY_STR_PG*',
    hosts: ['MY_STR_PGHOST'],
    user: 'MY_STR_PGUSER',
    password: 'MY_STR_PGPASSWORD',
    database: 'MY_STR_PGDATABASE',
    port: 'MY_STR_PGPORT',
    sslmode: 'MY_STR_PGSSLMODE',
  },
  {
    label: 'PG*',
    hosts: ['PGHOST_UNPOOLED', 'PGHOST'],
    user: 'PGUSER',
    password: 'PGPASSWORD',
    database: 'PGDATABASE',
    port: 'PGPORT',
    sslmode: 'PGSSLMODE',
  },
];

/** Variabile che indica il database in uso adesso. */
export const CURRENT_DATABASE_ENV = 'DATABASE_URL';

const DEFAULT_PORT = 5432;
/** Schema letto da Prisma quando l'URL non ha il parametro `schema`. */
const DEFAULT_SCHEMA = 'public';
/** Caratteri di controllo (a capo compreso): renderebbero ambigua l'identità del database. */
const CONTROL_CHARS = /\p{Cc}/u;
const POSTGRES_SCHEME = /^postgres(?:ql)?:\/\//i;
const UNSUPPORTED_SCHEME = /^prisma(?:\+postgres)?:\/\//i;
/** Host ammessi per gli insiemi "a pezzi": lettere, cifre, punti e trattini (niente spazi o @). */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;

/**
 * Identità di un database: host normalizzato (senza "-pooler"), porta, nome del database, utente
 * e schema letto da Prisma (parametro `schema`, "public" se manca): due schemi diversi dello
 * stesso database sono dati diversi.
 */
export type DbIdentity = {
  host: string;
  port: number;
  database: string;
  user: string;
  schema: string;
};

/** Una variabile (o un insieme "a pezzi") letta dall'ambiente. Resta sul server. */
export type SourceEntry = {
  envNames: string[];
  identity: DbIdentity;
  /** Stringa di connessione completa così com'è nell'ambiente; null se manca la password. */
  rawUrl: string | null;
  pooled: boolean;
  tlsDisabled: boolean;
  /** Etichetta dell'insieme "a pezzi" a cui manca la password (null per le variabili URL). */
  incompleteLabel: string | null;
};

export type SkippedEnv = { name: string; reason: 'invalid' | 'unsupported' };

/** Gruppo di variabili che puntano allo stesso database. Resta sul server (contiene l'URL). */
export type SourceGroup = {
  key: string;
  identity: DbIdentity;
  envNames: string[];
  /** URL da usare per collegarsi (già con i parametri di sicurezza), null se nessuna è completa. */
  connectionUrl: string | null;
  current: boolean;
  incompleteLabels: string[];
  providerHint: string;
};

export type LegacyDiscovery = {
  groups: SourceGroup[];
  skipped: SkippedEnv[];
  /** true se l'identità di DATABASE_URL è nota (altrimenti nessun gruppo è segnato «in uso»). */
  currentDetected: boolean;
};

/** Host minuscolo, senza punto finale e senza il suffisso "-pooler" di Neon nel primo segmento. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^([^.]+)-pooler\./, '$1.');
}

/** true per i pooler di transazioni (Neon "-pooler", Supabase "pooler."). */
export function isPoolerHost(host: string): boolean {
  const lower = host.toLowerCase();
  return /-pooler\./.test(lower) || /(^|\.)pooler\./.test(lower);
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parsePort(value: string | undefined): number | null {
  if (!value) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
}

type ParsedUrl =
  | {
      kind: 'ok';
      identity: DbIdentity;
      hasPassword: boolean;
      pooled: boolean;
      tlsDisabled: boolean;
    }
  | { kind: 'invalid' }
  | { kind: 'unsupported' };

/** Legge identità, password presente e modalità TLS da una stringa di connessione Postgres. */
export function parseDatabaseUrl(raw: string): ParsedUrl {
  const value = raw.trim();
  if (UNSUPPORTED_SCHEME.test(value)) return { kind: 'unsupported' };
  // Un '#' non codificato (per esempio dentro una password) renderebbe ambigua la lettura.
  if (!POSTGRES_SCHEME.test(value) || value.includes('#')) return { kind: 'invalid' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'invalid' };
  }
  const rawHost = url.hostname;
  const port = parsePort(url.port);
  const user = safeDecode(url.username);
  const databasePath = safeDecode(url.pathname.replace(/^\//, ''));
  const schema = url.searchParams.get('schema')?.trim() || DEFAULT_SCHEMA;
  if (
    !rawHost ||
    port === null ||
    !user ||
    databasePath === null ||
    databasePath.includes('/') ||
    CONTROL_CHARS.test(`${user}${databasePath}${schema}`)
  ) {
    return { kind: 'invalid' };
  }
  const sslmode = url.searchParams.get('sslmode')?.toLowerCase() ?? '';
  return {
    kind: 'ok',
    identity: {
      host: normalizeHost(rawHost),
      port,
      // Senza nome, Postgres usa il database che si chiama come l'utente.
      database: databasePath || user,
      user,
      schema,
    },
    hasPassword: url.password.length > 0,
    pooled: isPoolerHost(rawHost),
    tlsDisabled: sslmode === 'disable' || sslmode === 'allow',
  };
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Legge un insieme "a pezzi". null se manca l'host; incompleto (rawUrl null) senza password. */
function componentEntry(
  env: Record<string, string | undefined>,
  set: ComponentSet,
): { entry: SourceEntry } | { skipped: SkippedEnv } | null {
  const hostName = set.hosts.find((name) => envValue(env, name));
  if (!hostName) return null;
  const present = [
    ...set.hosts,
    set.user,
    set.password,
    set.database,
    set.port,
    set.sslmode,
  ].filter((name) => envValue(env, name));
  const host = envValue(env, hostName) ?? '';
  const user = envValue(env, set.user);
  const database = envValue(env, set.database);
  const port = parsePort(envValue(env, set.port));
  if (!HOST_NAME.test(host) || port === null) {
    return { skipped: { name: hostName, reason: 'invalid' } };
  }
  if (!user || !database || CONTROL_CHARS.test(`${user}${database}`)) {
    // Senza utente o database non si sa nemmeno quale database sia: incompleto e senza gruppo.
    return { skipped: { name: hostName, reason: 'invalid' } };
  }
  const password = envValue(env, set.password);
  const sslmode = envValue(env, set.sslmode)?.toLowerCase() ?? '';
  const rawUrl = password
    ? `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=require`
    : null;
  return {
    entry: {
      envNames: present,
      identity: { host: normalizeHost(host), port, database, user, schema: DEFAULT_SCHEMA },
      rawUrl,
      pooled: isPoolerHost(host),
      tlsDisabled: sslmode === 'disable' || sslmode === 'allow',
      incompleteLabel: password ? null : set.label,
    },
  };
}

/** Legge l'elenco fisso di variabili: voci valide e variabili scartate (solo il nome). */
export function readLegacySources(env: Record<string, string | undefined>): {
  entries: SourceEntry[];
  skipped: SkippedEnv[];
} {
  const entries: SourceEntry[] = [];
  const skipped: SkippedEnv[] = [];
  for (const name of LEGACY_URL_ENV_NAMES) {
    const raw = envValue(env, name);
    if (!raw) continue;
    const parsed = parseDatabaseUrl(raw);
    if (parsed.kind !== 'ok') {
      skipped.push({ name, reason: parsed.kind });
      continue;
    }
    entries.push({
      envNames: [name],
      identity: parsed.identity,
      rawUrl: parsed.hasPassword ? raw : null,
      pooled: parsed.pooled,
      tlsDisabled: parsed.tlsDisabled,
      incompleteLabel: parsed.hasPassword ? null : name,
    });
  }
  for (const set of LEGACY_COMPONENT_SETS) {
    const result = componentEntry(env, set);
    if (!result) continue;
    if ('skipped' in result) skipped.push(result.skipped);
    else entries.push(result.entry);
  }
  return { entries, skipped };
}

/** Identità come testo; lo schema compare solo se non è quello predefinito ("public"). */
export function identityString(identity: DbIdentity): string {
  const parts: Array<string | number> = [
    identity.host,
    identity.port,
    identity.database,
    identity.user,
  ];
  if (identity.schema !== DEFAULT_SCHEMA) parts.push(identity.schema);
  return parts.join('\n');
}

/** Chiave derivata dal segreto di better-auth, con un'etichetta diversa per ogni uso. */
export function deriveKey(secret: string, label: string): Buffer {
  return createHmac('sha256', secret).update(label).digest();
}

const SOURCE_KEY_LABEL = 'solco/legacy-users/source-key/v1';
const PREVIEW_KEY_LABEL = 'solco/legacy-users/preview-token/v1';

/** Impronta opaca di un database (HMAC dell'identità): mai l'URL, l'host o le credenziali. */
export function sourceKeyFor(identity: DbIdentity, secret: string): string {
  return createHmac('sha256', deriveKey(secret, SOURCE_KEY_LABEL))
    .update(identityString(identity))
    .digest('hex')
    .slice(0, 32);
}

const PRISMA_PARAMS: Record<string, string> = {
  // Una sola connessione, tempi di attesa brevi: è una lettura occasionale da una pagina admin.
  connection_limit: '1',
  connect_timeout: '5',
  pool_timeout: '5',
  socket_timeout: '10',
};

/**
 * URL per il client Prisma separato: connessione cifrata obbligatoria (anche per le varianti
 * "NO_SSL"), una connessione, timeout brevi, pgbouncer=true sui pooler (niente prepared statement
 * persistenti). Solo la parte dopo "?" viene riscritta: utente e password restano codificati come
 * nell'originale.
 */
export function buildConnectionUrl(raw: string, pooled: boolean): string {
  const value = raw.trim();
  const queryAt = value.indexOf('?');
  const base = queryAt === -1 ? value : value.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? '' : value.slice(queryAt + 1));
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (Object.hasOwn(PRISMA_PARAMS, lower) || lower === 'sslmode') params.delete(key);
  }
  params.set('sslmode', 'require');
  for (const [key, setting] of Object.entries(PRISMA_PARAMS)) params.set(key, setting);
  if (pooled) params.set('pgbouncer', 'true');
  return `${base}?${params.toString()}`;
}

function entryRank(entry: SourceEntry): number {
  if (!entry.rawUrl) return 99;
  return (entry.tlsDisabled ? 4 : 0) + (entry.pooled ? 1 : 0);
}

/** Raggruppa le voci per database e segna «in uso» quello di DATABASE_URL. */
export function groupLegacySources(
  env: Record<string, string | undefined>,
  secret: string,
): LegacyDiscovery {
  const { entries, skipped } = readLegacySources(env);
  const currentRaw = envValue(env, CURRENT_DATABASE_ENV);
  const currentParsed = currentRaw ? parseDatabaseUrl(currentRaw) : null;
  const currentIdentity =
    currentParsed?.kind === 'ok' ? identityString(currentParsed.identity) : null;

  const byIdentity = new Map<string, SourceEntry[]>();
  for (const entry of entries) {
    const id = identityString(entry.identity);
    const list = byIdentity.get(id);
    if (list) list.push(entry);
    else byIdentity.set(id, [entry]);
  }

  const groups: SourceGroup[] = [];
  for (const [id, list] of byIdentity) {
    const first = list[0];
    if (!first) continue;
    // Stabile: a parità di rango vince l'ordine dell'elenco fisso (il vecchio sito per primo).
    const best = [...list].sort((a, b) => entryRank(a) - entryRank(b))[0];
    const connectionUrl = best?.rawUrl ? buildConnectionUrl(best.rawUrl, best.pooled) : null;
    groups.push({
      key: sourceKeyFor(first.identity, secret),
      identity: first.identity,
      envNames: [...new Set(list.flatMap((entry) => entry.envNames))],
      connectionUrl,
      current: currentIdentity !== null && id === currentIdentity,
      incompleteLabels: list.flatMap((entry) =>
        entry.incompleteLabel ? [entry.incompleteLabel] : [],
      ),
      providerHint: providerHint(first.identity.host),
    });
  }
  // Prima il database in uso, poi gli altri nell'ordine in cui compaiono le loro variabili.
  groups.sort((a, b) => Number(b.current) - Number(a.current));
  return { groups, skipped, currentDetected: currentIdentity !== null };
}

/**
 * Fornitore riconoscibile dall'host, SENZA mostrare l'host: solo il nome del servizio e, quando è
 * nel nome, la regione (es. "Neon · eu-central-1"). Tutto il resto è "altro".
 */
export function providerHint(host: string): string {
  const h = host.toLowerCase();
  const neon = /\.([a-z]{2,}-[a-z]+-\d|[a-z]+\d?)\.(?:aws|azure)\.neon\.tech$/.exec(h);
  if (neon) return `Neon · ${neon[1]}`;
  if (h.endsWith('.neon.tech')) return 'Neon';
  const vercel = /\.([a-z]{2,}-[a-z]+-\d)\.postgres\.vercel-storage\.com$/.exec(h);
  if (vercel) return `Vercel Postgres (Neon) · ${vercel[1]}`;
  if (h.endsWith('.vercel-storage.com')) return 'Vercel Postgres (Neon)';
  const rds = /\.([a-z]{2,}-[a-z]+-\d)\.rds\.amazonaws\.com$/.exec(h);
  if (rds) return `AWS RDS · ${rds[1]}`;
  if (h.endsWith('.compute-1.amazonaws.com') || h.endsWith('.compute.amazonaws.com')) {
    return 'AWS (es. Heroku)';
  }
  if (h.endsWith('.amazonaws.com')) return 'AWS';
  if (h.endsWith('.supabase.co') || h.endsWith('.supabase.com')) return 'Supabase';
  if (h.endsWith('.render.com')) return 'Render';
  if (h.endsWith('.rlwy.net') || h.endsWith('.railway.app') || h.endsWith('.railway.internal')) {
    return 'Railway';
  }
  if (h === 'db.prisma.io' || h.endsWith('.prisma.io') || h.endsWith('.prisma-data.net')) {
    return 'Prisma Postgres';
  }
  if (h.includes('polsia')) return 'Polsia';
  if (h.endsWith('.aivencloud.com')) return 'Aiven';
  if (h.endsWith('.ondigitalocean.com')) return 'DigitalOcean';
  if (h.endsWith('.azure.com')) return 'Azure';
  if (h.endsWith('.cockroachlabs.cloud')) return 'CockroachDB';
  if (h === 'localhost' || h.startsWith('127.') || h === '[::1]') return 'locale';
  return 'altro';
}

// ---------------------------------------------------------------------------------------------
// Errori: solo una categoria, mai il testo del driver
// ---------------------------------------------------------------------------------------------

export const LEGACY_ERROR_KINDS = [
  'timeout',
  'auth',
  'ssl',
  'not_found',
  'unreachable',
  'too_large',
  'unknown',
] as const;
export type LegacyErrorKind = (typeof LEGACY_ERROR_KINDS)[number];

/** Errore lanciato quando la lettura supera la scadenza complessiva. */
export class LegacyDeadlineError extends Error {
  constructor() {
    super('Tempo massimo superato');
    this.name = 'LegacyDeadlineError';
  }
}

/** Il vecchio database ha più utenti di quanti se ne possano leggere in una richiesta. */
export class LegacyTooLargeError extends Error {
  constructor() {
    super('Troppi utenti');
    this.name = 'LegacyTooLargeError';
  }
}

const INIT_CODES: Record<string, LegacyErrorKind> = {
  P1000: 'auth',
  P1001: 'unreachable',
  P1002: 'timeout',
  P1003: 'not_found',
  P1008: 'timeout',
  P1010: 'auth',
  P1011: 'ssl',
  P1017: 'unreachable',
  P2024: 'timeout',
  P2028: 'timeout',
};

const SQLSTATE_KINDS: Array<[RegExp, LegacyErrorKind]> = [
  [/^57014$/, 'timeout'],
  [/^28/, 'auth'],
  [/^(3D000|42P01)$/, 'not_found'],
  [/^08/, 'unreachable'],
];

const MESSAGE_KINDS: Array<[RegExp, LegacyErrorKind]> = [
  [/timed?\s?out|timeout|canceling statement/i, 'timeout'],
  [/\btls\b|\bssl\b|certificate/i, 'ssl'],
  [/password authentication|authentication failed|permission denied/i, 'auth'],
  [/does not exist/i, 'not_found'],
  [
    /can't reach|econnrefused|enotfound|eai_again|connection refused|closed the connection/i,
    'unreachable',
  ],
];

/**
 * Categoria di un errore di connessione o di query. Il messaggio serve SOLO a classificare: non
 * viene mai restituito o scritto nei log (può contenere host e utente).
 */
export function legacyErrorKind(error: unknown): LegacyErrorKind {
  if (error instanceof LegacyDeadlineError) return 'timeout';
  if (error instanceof LegacyTooLargeError) return 'too_large';
  if (typeof error !== 'object' || error === null) return 'unknown';
  const record = error as {
    errorCode?: unknown;
    code?: unknown;
    meta?: unknown;
    message?: unknown;
  };
  const code =
    typeof record.errorCode === 'string'
      ? record.errorCode
      : typeof record.code === 'string'
        ? record.code
        : '';
  const known = INIT_CODES[code];
  if (known) return known;
  const meta = record.meta as { code?: unknown } | undefined;
  const sqlState =
    typeof meta?.code === 'string' ? meta.code : /^[0-9A-Z]{5}$/.test(code) ? code : '';
  for (const [pattern, kind] of SQLSTATE_KINDS) if (sqlState && pattern.test(sqlState)) return kind;
  const message = typeof record.message === 'string' ? record.message : '';
  for (const [pattern, kind] of MESSAGE_KINDS) if (pattern.test(message)) return kind;
  return 'unknown';
}

/** Nome dell'errore per i log (mai il messaggio). */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// ---------------------------------------------------------------------------------------------
// Password: formato dell'accesso attuale
// ---------------------------------------------------------------------------------------------

/**
 * Formato delle password di better-auth 1.6 (src/lib/auth.ts non imposta un hash personalizzato):
 * scrypt N=16384, r=16, p=1, chiave di 64 byte, sale di 16 byte casuali scritto in esadecimale e
 * usato COME TESTO; salvato come "<sale: 32 esadecimali>:<chiave: 128 esadecimali>" minuscoli
 * (node_modules/@better-auth/utils/dist/password.node.mjs). Solo questo formato si copia: ogni
 * altro hash (bcrypt "$2b$…", argon2 "$argon2id$…", testo, vuoto) non sarebbe verificabile.
 */
export const COMPATIBLE_PASSWORD_HASH = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

export function isCompatiblePasswordHash(value: unknown): value is string {
  return typeof value === 'string' && COMPATIBLE_PASSWORD_HASH.test(value);
}

// ---------------------------------------------------------------------------------------------
// Righe del vecchio database (lette come JSON) e piano di trasferimento
// ---------------------------------------------------------------------------------------------

export type LegacyUserRow = {
  id: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  image: string | null;
  role: string | null;
  banned: boolean;
  banReason: string | null;
  banExpires: Date | null;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type LegacyAccountRow = {
  userId: string;
  providerId: string;
  accountId: string;
  password: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

const MIN_LEGACY_TIME = Date.UTC(1970, 0, 1);
const MAX_LEGACY_TIME = Date.UTC(2200, 0, 1);

/**
 * Data da una colonna letta con to_jsonb: "2024-05-01T10:00:00.123" per `timestamp` (senza fuso,
 * Prisma ci salva l'ora UTC) oppure con l'offset per `timestamptz`.
 */
export function parseLegacyDate(value: unknown): Date | null {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string' && value) {
    const hasZone = /(?:z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
    date = new Date(hasZone ? value : `${value}Z`);
  } else return null;
  const time = date.getTime();
  // Fuori da questo intervallo è un valore guasto (e non sarebbe una data ISO valida).
  return Number.isNaN(time) || time < MIN_LEGACY_TIME || time > MAX_LEGACY_TIME ? null : date;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseLegacyUser(value: unknown): LegacyUserRow | null {
  const row = asRecord(value);
  const id = asString(row?.id);
  if (!row || !id) return null;
  return {
    id,
    name: asString(row.name),
    email: asString(row.email),
    emailVerified: row.emailVerified === true,
    image: asString(row.image),
    role: asString(row.role),
    banned: row.banned === true,
    banReason: asString(row.banReason),
    banExpires: parseLegacyDate(row.banExpires),
    phoneNumber: asString(row.phoneNumber),
    phoneNumberVerified: row.phoneNumberVerified === true,
    createdAt: parseLegacyDate(row.createdAt),
    updatedAt: parseLegacyDate(row.updatedAt),
  };
}

export function parseLegacyAccount(value: unknown): LegacyAccountRow | null {
  const row = asRecord(value);
  const userId = asString(row?.userId);
  const providerId = asString(row?.providerId);
  const accountId = asString(row?.accountId);
  if (!row || !userId || !providerId || !accountId) return null;
  return {
    userId,
    providerId,
    accountId,
    password: asString(row.password),
    createdAt: parseLegacyDate(row.createdAt),
    updatedAt: parseLegacyDate(row.updatedAt),
  };
}

const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN =
  /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Email minuscola e senza spazi ai lati, oppure null se non è un indirizzo valido. */
export function normalizeEmail(value: string | null): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}

const MAX_NAME_LENGTH = 80;
const MAX_IMAGE_LENGTH = 2048;
const MAX_BAN_REASON_LENGTH = 500;
const SAFE_LEGACY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_ACCOUNT_ID_LENGTH = 255;
const CREDENTIAL_PROVIDER = 'credential';

/** Nome breve (in caratteri, non byte), oppure il nome generico degli account senza nome. */
function cleanName(value: string | null): string {
  const name = Array.from((value ?? '').trim())
    .slice(0, MAX_NAME_LENGTH)
    .join('')
    .trim();
  return name || phoneAccountName();
}

/** Solo immagini https senza credenziali nell'indirizzo; altrimenti nessuna immagine. */
export function safeImageUrl(value: string | null): string | null {
  if (!value || value.length > MAX_IMAGE_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Ruolo admin anche in una lista separata da virgole ("admin,user"). */
export function hasAdminRole(role: string | null): boolean {
  return (role ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .includes('admin');
}

/** Chiave di un collegamento OAuth (fornitore + id dell'account presso il fornitore). */
export function oauthKey(providerId: string, accountId: string): string {
  return `${providerId}\u0000${accountId}`;
}

/** Id casuale come quelli di better-auth: 32 caratteri alfanumerici. */
export function randomId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  while (out.length < 32) {
    for (const byte of randomBytes(48)) {
      // 248 = 4 × 62: scarta i byte che renderebbero alcune lettere più probabili.
      if (byte < 248) out += alphabet[byte % 62];
      if (out.length === 32) break;
    }
  }
  return out;
}

export type LegacySnapshot = { users: LegacyUserRow[]; accounts: LegacyAccountRow[] };

/** Stato del database attuale che serve al piano (solo insiemi in memoria sul server). */
export type CurrentState = {
  existingEmails: ReadonlySet<string>;
  takenIds: ReadonlySet<string>;
  takenPhones: ReadonlySet<string>;
  takenOAuth: ReadonlySet<string>;
  /** Id del vecchio database già trasferiti, da QUALSIASI fonte (registro LegacyUserImport). */
  importedLegacyIds: ReadonlySet<string>;
  /** Email (minuscole) a cui il sito dà da solo il ruolo admin: mai create dal trasferimento. */
  reservedEmails: ReadonlySet<string>;
  /** Id a cui il sito dà da solo il ruolo admin: mai riusati per un account trasferito. */
  reservedIds: ReadonlySet<string>;
};

/**
 * Identità che il sito promuove ad admin per conto suo: l'email di REQUESTED_ADMIN_EMAIL (seed
 * a ogni avvio, anche senza email verificata), POLSIA_OWNER_EMAIL (hook di better-auth) e l'id di
 * ADMIN_USER_ID (hook dell'app). Un account trasferito con una di queste identità diventerebbe
 * admin senza che nessuno lo decida: le email vengono saltate («da gestire a mano») e l'id non
 * viene mai tenuto.
 */
export function reservedAdminIdentities(env: Record<string, string | undefined>): {
  emails: Set<string>;
  ids: Set<string>;
} {
  const emails = new Set<string>();
  for (const value of [REQUESTED_ADMIN_EMAIL, env.POLSIA_OWNER_EMAIL]) {
    const email = value?.trim().toLowerCase();
    if (email) emails.add(email);
  }
  const ids = new Set<string>();
  const adminId = env.ADMIN_USER_ID?.trim();
  if (adminId) ids.add(adminId);
  return { emails, ids };
}

/** Valori da cercare nel database attuale prima di costruire il piano. */
export function lookupKeys(snapshot: LegacySnapshot): {
  emails: string[];
  ids: string[];
  phones: string[];
  accountIds: string[];
} {
  const emails = new Set<string>();
  const ids = new Set<string>();
  const phones = new Set<string>();
  for (const user of snapshot.users) {
    const email = normalizeEmail(user.email);
    if (email) emails.add(email);
    if (SAFE_LEGACY_ID.test(user.id)) ids.add(user.id);
    if (user.phoneNumber && isValidE164(user.phoneNumber)) phones.add(user.phoneNumber);
  }
  const accountIds = new Set<string>();
  for (const account of snapshot.accounts) {
    if (account.providerId !== CREDENTIAL_PROVIDER) accountIds.add(account.accountId);
  }
  return {
    emails: [...emails],
    ids: [...ids],
    phones: [...phones],
    accountIds: [...accountIds],
  };
}

export type PlannedAccount = {
  providerId: string;
  accountId: string | null;
  password: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PlannedUser = {
  legacyId: string;
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    role: 'user';
    banned: boolean;
    banReason: string | null;
    banExpires: Date | null;
    phoneNumber: string | null;
    phoneNumberVerified: boolean | null;
    createdAt: Date;
    updatedAt: Date;
  };
  /** Credenziale (accountId null = l'id dell'utente) e collegamenti OAuth senza token. */
  accounts: PlannedAccount[];
  loginMethod: 'password' | 'oauth' | 'phone' | 'reset';
};

export type LegacyPlanCounts = {
  users: number;
  verified: number;
  banned: number;
  withPhone: number;
  legacyAdmins: number;
  oldestAt: string | null;
  newestAt: string | null;
  alreadyImported: number;
  alreadyPresent: number;
  duplicateInSource: number;
  invalidEmail: number;
  importable: number;
  passwordCompatible: number;
  passwordIncompatible: number;
  oauthOnly: number;
  phoneOnly: number;
  needsPasswordReset: number;
  adminsToDemote: number;
  phonesDropped: number;
  oauthAccountsSkipped: number;
  reservedAdmin: number;
};

export type LegacyPlan = { toImport: PlannedUser[]; counts: LegacyPlanCounts };

function byCreation(a: LegacyUserRow, b: LegacyUserRow): number {
  const at = a.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bt = b.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Piano esatto del trasferimento, nell'ordine di iscrizione (il più vecchio prima: in caso di
 * email doppie nel vecchio database vince l'account più vecchio). Regole:
 *   - già importato, da qualsiasi fonte (registro LegacyUserImport) → saltato: un account
 *     cancellato qui o che ha cambiato email non rinasce da un'altra variabile dello stesso database;
 *   - email non valida, oppure email provvisoria del telefono senza un numero trasferibile
 *     (nessun modo di accedere) → saltato;
 *   - email già presente nel database attuale (senza distinguere maiuscole) → saltato: mai unire,
 *     mai sovrascrivere;
 *   - email a cui il sito dà da solo il ruolo admin (reservedEmails) → saltato, «da gestire a mano»;
 *     un id riservato (reservedIds) non viene mai tenuto;
 *   - ruolo SEMPRE "user"; immagine solo https; blocco e date conservati;
 *   - telefono solo se E.164, verificato nel vecchio sito e libero nel database attuale (un numero
 *     non verificato farebbe entrare nell'account chiunque lo verifichi via SMS);
 *   - password solo nel formato compatibile; OAuth solo providerId + accountId (niente token) e
 *     solo se quel collegamento non esiste già nel database attuale.
 */
export function buildLegacyPlan(
  snapshot: LegacySnapshot,
  state: CurrentState,
  now: Date,
  newId: () => string = randomId,
): LegacyPlan {
  const counts: LegacyPlanCounts = {
    users: snapshot.users.length,
    verified: 0,
    banned: 0,
    withPhone: 0,
    legacyAdmins: 0,
    oldestAt: null,
    newestAt: null,
    alreadyImported: 0,
    alreadyPresent: 0,
    duplicateInSource: 0,
    invalidEmail: 0,
    importable: 0,
    passwordCompatible: 0,
    passwordIncompatible: 0,
    oauthOnly: 0,
    phoneOnly: 0,
    needsPasswordReset: 0,
    adminsToDemote: 0,
    phonesDropped: 0,
    oauthAccountsSkipped: 0,
    reservedAdmin: 0,
  };

  const accountsByUser = new Map<string, LegacyAccountRow[]>();
  for (const account of snapshot.accounts) {
    const list = accountsByUser.get(account.userId);
    if (list) list.push(account);
    else accountsByUser.set(account.userId, [account]);
  }

  let oldest: number | null = null;
  let newest: number | null = null;
  const seenEmails = new Set<string>();
  const plannedIds = new Set<string>();
  const plannedPhones = new Set<string>();
  const plannedOAuth = new Set<string>();
  const toImport: PlannedUser[] = [];

  for (const legacy of [...snapshot.users].sort(byCreation)) {
    if (legacy.emailVerified) counts.verified += 1;
    if (legacy.banned) counts.banned += 1;
    if (legacy.phoneNumber) counts.withPhone += 1;
    const wasAdmin = hasAdminRole(legacy.role);
    if (wasAdmin) counts.legacyAdmins += 1;
    const created = legacy.createdAt?.getTime();
    if (created !== undefined) {
      oldest = oldest === null ? created : Math.min(oldest, created);
      newest = newest === null ? created : Math.max(newest, created);
    }

    if (state.importedLegacyIds.has(legacy.id)) {
      counts.alreadyImported += 1;
      continue;
    }
    const email = normalizeEmail(legacy.email);
    if (!email) {
      counts.invalidEmail += 1;
      continue;
    }
    if (state.existingEmails.has(email)) {
      counts.alreadyPresent += 1;
      continue;
    }
    if (state.reservedEmails.has(email)) {
      // Diventerebbe admin da solo (seed, hook di better-auth): l'admin lo gestisce a mano.
      counts.reservedAdmin += 1;
      continue;
    }
    if (seenEmails.has(email)) {
      counts.duplicateInSource += 1;
      continue;
    }

    const phone = legacy.phoneNumber;
    const keepPhone =
      phone !== null &&
      isValidE164(phone) &&
      legacy.phoneNumberVerified &&
      !state.takenPhones.has(phone) &&
      !plannedPhones.has(phone);
    if (isPhoneAccountEmail(email) && !keepPhone) {
      // Email provvisoria non consegnabile e nessun numero: nessuno potrebbe mai accedervi.
      counts.invalidEmail += 1;
      continue;
    }

    seenEmails.add(email);
    if (phone && !keepPhone) counts.phonesDropped += 1;
    if (keepPhone) plannedPhones.add(phone);

    const keepId =
      SAFE_LEGACY_ID.test(legacy.id) &&
      !state.takenIds.has(legacy.id) &&
      !state.reservedIds.has(legacy.id) &&
      !plannedIds.has(legacy.id);
    const id = keepId ? legacy.id : newId();
    plannedIds.add(id);

    const createdAt = legacy.createdAt ?? now;
    const updatedAt = legacy.updatedAt ?? createdAt;
    const accounts: PlannedAccount[] = [];
    let hasCredentialRow = false;
    let credential: PlannedAccount | null = null;
    for (const account of accountsByUser.get(legacy.id) ?? []) {
      const accountCreated = account.createdAt ?? createdAt;
      const accountUpdated = account.updatedAt ?? accountCreated;
      if (account.providerId === CREDENTIAL_PROVIDER) {
        hasCredentialRow = true;
        if (!credential && isCompatiblePasswordHash(account.password)) {
          credential = {
            providerId: CREDENTIAL_PROVIDER,
            accountId: null,
            password: account.password,
            createdAt: accountCreated,
            updatedAt: accountUpdated,
          };
        }
        continue;
      }
      const key = oauthKey(account.providerId, account.accountId);
      if (
        !SAFE_PROVIDER_ID.test(account.providerId) ||
        account.accountId.length > MAX_ACCOUNT_ID_LENGTH ||
        state.takenOAuth.has(key) ||
        plannedOAuth.has(key)
      ) {
        counts.oauthAccountsSkipped += 1;
        continue;
      }
      plannedOAuth.add(key);
      accounts.push({
        providerId: account.providerId,
        accountId: account.accountId,
        password: null,
        createdAt: accountCreated,
        updatedAt: accountUpdated,
      });
    }
    if (credential) accounts.unshift(credential);

    const loginMethod: PlannedUser['loginMethod'] = credential
      ? 'password'
      : accounts.length > 0
        ? 'oauth'
        : keepPhone
          ? 'phone'
          : 'reset';
    if (loginMethod === 'password') counts.passwordCompatible += 1;
    else if (loginMethod === 'oauth') counts.oauthOnly += 1;
    else if (loginMethod === 'phone') counts.phoneOnly += 1;
    else counts.needsPasswordReset += 1;
    if (hasCredentialRow && !credential) counts.passwordIncompatible += 1;
    if (wasAdmin) counts.adminsToDemote += 1;

    toImport.push({
      legacyId: legacy.id,
      user: {
        id,
        name: cleanName(legacy.name),
        email,
        emailVerified: legacy.emailVerified,
        image: safeImageUrl(legacy.image),
        role: 'user',
        banned: legacy.banned,
        banReason: legacy.banReason ? legacy.banReason.slice(0, MAX_BAN_REASON_LENGTH) : null,
        banExpires: legacy.banExpires,
        phoneNumber: keepPhone ? phone : null,
        phoneNumberVerified: keepPhone ? true : null,
        createdAt,
        updatedAt,
      },
      accounts,
      loginMethod,
    });
  }

  counts.importable = toImport.length;
  counts.oldestAt = oldest === null ? null : new Date(oldest).toISOString();
  counts.newestAt = newest === null ? null : new Date(newest).toISOString();
  return { toImport, counts };
}

// ---------------------------------------------------------------------------------------------
// Gettone dell'anteprima: firma HMAC, scadenza 15 minuti, legato alla fonte e agli utenti previsti
// ---------------------------------------------------------------------------------------------

export const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;
const FINGERPRINT_BYTES = 4;
const TOKEN_VERSION = 1;

/** Impronta dell'elenco degli utenti da importare (sha256 degli id ordinati). */
export function idsDigest(ids: readonly string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
}

function fingerprint(key: Buffer, id: string): Buffer {
  return createHmac('sha256', key).update(`fp\n${id}`).digest().subarray(0, FINGERPRINT_BYTES);
}

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

type TokenPayload = {
  v: number;
  s: string;
  h: string;
  n: number;
  f: string;
  iat: number;
  exp: number;
};

/**
 * Gettone firmato per il trasferimento: lega la fonte, l'elenco esatto degli utenti previsti
 * (digest + un'impronta HMAC di 4 byte per id, così il server può verificare che un piano
 * ricalcolato non contenga utenti NUOVI) e la scadenza. Non contiene id, email o URL in chiaro.
 */
export function signPreviewToken(input: {
  sourceKey: string;
  ids: readonly string[];
  secret: string;
  now: number;
}): { token: string; expiresAt: string } {
  const key = deriveKey(input.secret, PREVIEW_KEY_LABEL);
  const prints = input.ids.map((id) => fingerprint(key, id)).sort(Buffer.compare);
  const exp = input.now + PREVIEW_TOKEN_TTL_MS;
  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    s: input.sourceKey,
    h: idsDigest(input.ids),
    n: input.ids.length,
    f: Buffer.concat(prints).toString('base64url'),
    iat: input.now,
    exp,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${sign(key, body)}`, expiresAt: new Date(exp).toISOString() };
}

export type VerifiedPreview = { count: number; digest: string; prints: ReadonlySet<string> };

export type PreviewVerification =
  | { ok: true; preview: VerifiedPreview }
  | { ok: false; reason: 'invalid' | 'expired' };

function isPayload(value: unknown): value is TokenPayload {
  const record = asRecord(value);
  return (
    record !== null &&
    record.v === TOKEN_VERSION &&
    typeof record.s === 'string' &&
    typeof record.h === 'string' &&
    typeof record.f === 'string' &&
    Number.isSafeInteger(record.n) &&
    Number.isSafeInteger(record.iat) &&
    Number.isSafeInteger(record.exp)
  );
}

/** Verifica firma, fonte e scadenza del gettone. */
export function verifyPreviewToken(
  token: string,
  input: { sourceKey: string; secret: string; now: number },
): PreviewVerification {
  const key = deriveKey(input.secret, PREVIEW_KEY_LABEL);
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'invalid' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPayload(payload) || payload.s !== input.sourceKey) return { ok: false, reason: 'invalid' };
  if (input.now >= payload.exp) return { ok: false, reason: 'expired' };
  const raw = Buffer.from(payload.f, 'base64url');
  if (raw.length !== payload.n * FINGERPRINT_BYTES) return { ok: false, reason: 'invalid' };
  const prints = new Set<string>();
  for (let offset = 0; offset < raw.length; offset += FINGERPRINT_BYTES) {
    prints.add(raw.subarray(offset, offset + FINGERPRINT_BYTES).toString('hex'));
  }
  return { ok: true, preview: { count: payload.n, digest: payload.h, prints } };
}

/**
 * true se ogni utente del piano ricalcolato era nell'anteprima. Un piano più piccolo va bene
 * (lotti già importati, email registrate nel frattempo); un utente nuovo no.
 */
export function previewCovers(
  preview: VerifiedPreview,
  ids: readonly string[],
  secret: string,
): boolean {
  const key = deriveKey(secret, PREVIEW_KEY_LABEL);
  return ids.every((id) => preview.prints.has(fingerprint(key, id).toString('hex')));
}
