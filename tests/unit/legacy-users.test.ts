// @polsia:user-owned — regole pure di «Utenti del vecchio sito»: elenco fisso delle variabili,
// stesso database riconosciuto tra variabili con e senza pooler, «in uso», insiemi "a pezzi" senza
// password (incompleti), variabili mancanti o illeggibili, URL di connessione sicuro, fornitore
// senza host, categorie di errore, formato delle password di better-auth, piano di trasferimento
// (email senza maiuscole, ruolo mai admin, immagini https, telefono, password, OAuth senza token)
// e gettone dell'anteprima (firma, scadenza, fonte, utenti nuovi).
// @vitest-environment node
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';
import {
  buildConnectionUrl,
  buildLegacyPlan,
  type CurrentState,
  groupLegacySources,
  identityString,
  idsDigest,
  isCompatiblePasswordHash,
  type LegacyAccountRow,
  LegacyDeadlineError,
  LegacyTooLargeError,
  type LegacyUserRow,
  legacyErrorKind,
  lookupKeys,
  normalizeHost,
  oauthKey,
  parseLegacyAccount,
  parseLegacyDate,
  parseLegacyUser,
  previewCovers,
  providerHint,
  reservedAdminIdentities,
  safeImageUrl,
  signPreviewToken,
  verifyPreviewToken,
} from '@/lib/admin/legacy-users';
import {
  normalizePersistedAdminRoles,
  REQUESTED_ADMIN_EMAIL,
  resolveInitialSignupRole,
} from '@/lib/business/admin-account-policy';

const SECRET = 'segreto-di-prova-better-auth-0123456789';
const NOW = new Date('2026-11-15T10:00:00.000Z');

// Database A (in uso) e B (vecchio sito), entrambi Neon con host pooled e diretto.
const A_POOLED = 'ep-cool-moon-111111-pooler.eu-central-1.aws.neon.tech';
const A_DIRECT = 'ep-cool-moon-111111.eu-central-1.aws.neon.tech';
const B_POOLED = 'ep-old-river-222222-pooler.us-east-2.aws.neon.tech';
const B_DIRECT = 'ep-old-river-222222.us-east-2.aws.neon.tech';
const C_HOST = 'db-legacy.c9xyz.eu-west-1.rds.amazonaws.com';

const url = (host: string, extra = '?sslmode=require', user = 'neondb_owner', pass = 'pw%23A1') =>
  `postgresql://${user}:${pass}@${host}/neondb${extra}`;

function baseEnv(): Record<string, string | undefined> {
  return {
    DATABASE_URL: url(A_POOLED),
    DATABASE_URL_UNPOOLED: url(A_DIRECT),
    POSTGRES_URL: url(A_POOLED),
    PGHOST: A_POOLED,
    PGUSER: 'neondb_owner',
    PGDATABASE: 'neondb',
    SOLCO_DATABASE_URL: url(B_POOLED, '?sslmode=require', 'neondb_owner', 'pwB'),
    SOLCO_DATABASE_URL_UNPOOLED: url(B_DIRECT, '?sslmode=require', 'neondb_owner', 'pwB'),
    SOLCO_POSTGRES_URL_NO_SSL: url(B_POOLED, '', 'neondb_owner', 'pwB'),
    SOLCO_PGHOST: B_POOLED,
    SOLCO_PGUSER: 'neondb_owner',
    SOLCO_PGPASSWORD: 'pwB',
    SOLCO_PGDATABASE: 'neondb',
    MY_STR_PGHOST: C_HOST,
    MY_STR_PGUSER: 'solco',
    MY_STR_PGDATABASE: 'solco',
    MY_STR_PGPORT: '5432',
    MY_STR_PGSSLMODE: 'require',
    BETTER_AUTH_SECRET: SECRET,
  };
}

describe('fonti: raggruppamento e «in uso»', () => {
  it('riconosce lo stesso database tra host con e senza pooler e segna «in uso» DATABASE_URL', () => {
    const { groups, currentDetected, skipped } = groupLegacySources(baseEnv(), SECRET);
    expect(currentDetected).toBe(true);
    expect(skipped).toEqual([]);
    expect(groups).toHaveLength(3);

    const [current, ...others] = groups;
    expect(current?.current).toBe(true);
    expect(current?.envNames).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL', 'PGHOST']),
    );
    expect(current?.incompleteLabels).toEqual(['PG*']);
    expect(others.every((group) => !group.current)).toBe(true);

    const old = others.find((group) => group.envNames.includes('SOLCO_DATABASE_URL'));
    expect(old?.envNames).toEqual(
      expect.arrayContaining([
        'SOLCO_DATABASE_URL',
        'SOLCO_DATABASE_URL_UNPOOLED',
        'SOLCO_POSTGRES_URL_NO_SSL',
        'SOLCO_PGHOST',
        'SOLCO_PGPASSWORD',
      ]),
    );
    // Si collega all'host diretto (senza pooler), con TLS obbligatorio e una sola connessione.
    expect(old?.connectionUrl).toContain(`@${B_DIRECT}/neondb?`);
    expect(old?.connectionUrl).toContain('sslmode=require');
    expect(old?.connectionUrl).toContain('connection_limit=1');
    expect(old?.connectionUrl).not.toContain('pgbouncer');
    expect(old?.providerHint).toBe('Neon · us-east-2');
  });

  it('un insieme "a pezzi" senza password è incompleto: nessuna connessione, nessuna credenziale inventata', () => {
    const { groups } = groupLegacySources(baseEnv(), SECRET);
    const rds = groups.find((group) => group.envNames.includes('MY_STR_PGHOST'));
    expect(rds?.connectionUrl).toBeNull();
    expect(rds?.incompleteLabels).toEqual(['MY_STR_PG*']);
    expect(rds?.providerHint).toBe('AWS RDS · eu-west-1');
  });

  it('se un URL completo punta allo stesso database, il gruppo usa quell’URL', () => {
    const env = {
      ...baseEnv(),
      MY_SOLCO_DATABASE_URL: `postgres://solco:pwC@${C_HOST}:5432/solco`,
    };
    const rds = groupLegacySources(env, SECRET).groups.find((group) =>
      group.envNames.includes('MY_STR_PGHOST'),
    );
    expect(rds?.envNames).toEqual(expect.arrayContaining(['MY_SOLCO_DATABASE_URL']));
    expect(rds?.connectionUrl).toContain('postgres://solco:pwC@');
    expect(rds?.incompleteLabels).toEqual(['MY_STR_PG*']);
  });

  it('la chiave è un’impronta opaca: 32 esadecimali, stabile, senza host o utente', () => {
    const first = groupLegacySources(baseEnv(), SECRET).groups;
    const second = groupLegacySources(baseEnv(), SECRET).groups;
    expect(first.map((g) => g.key)).toEqual(second.map((g) => g.key));
    for (const group of first) {
      expect(group.key).toMatch(/^[a-f0-9]{32}$/);
      expect(group.key).not.toContain('neon');
    }
    // Un altro segreto dà altre chiavi.
    const other = groupLegacySources(baseEnv(), 'altro-segreto').groups;
    expect(other[0]?.key).not.toBe(first[0]?.key);
  });

  it('utenti diversi sullo stesso host sono gruppi diversi', () => {
    const env = {
      DATABASE_URL: url(A_POOLED),
      OLD_DATABASE_URL: url(A_DIRECT, '?sslmode=require', 'altro_utente'),
    };
    const { groups } = groupLegacySources(env, SECRET);
    expect(groups).toHaveLength(2);
    expect(groups.filter((group) => group.current)).toHaveLength(1);
  });

  it('nessuna variabile: nessun gruppo e database in uso non riconosciuto', () => {
    expect(groupLegacySources({}, SECRET)).toEqual({
      groups: [],
      skipped: [],
      currentDetected: false,
    });
  });

  it('legge solo l’elenco fisso: un nome qualunque viene ignorato', () => {
    const { groups } = groupLegacySources(
      { RANDOM_DATABASE_URL: url(B_DIRECT), MY_DB: url(C_HOST) },
      SECRET,
    );
    expect(groups).toEqual([]);
  });

  it('URL illeggibili e Accelerate sono scartati col solo nome della variabile', () => {
    const { groups, skipped } = groupLegacySources(
      {
        OLD_DATABASE_URL: 'non è un url',
        LEGACY_DATABASE_URL: 'prisma+postgres://accelerate.prisma-data.net/?api_key=segreta',
        SOLCO_DATABASE_URL: 'postgres://u:pa#ss@host/db',
      },
      SECRET,
    );
    expect(groups).toEqual([]);
    expect(skipped).toEqual([
      { name: 'OLD_DATABASE_URL', reason: 'invalid' },
      { name: 'LEGACY_DATABASE_URL', reason: 'unsupported' },
      { name: 'SOLCO_DATABASE_URL', reason: 'invalid' },
    ]);
    expect(JSON.stringify(skipped)).not.toContain('segreta');
  });

  it('un URL senza password è incompleto', () => {
    const { groups } = groupLegacySources(
      { OLD_DATABASE_URL: `postgres://solo_utente@${B_DIRECT}/neondb` },
      SECRET,
    );
    expect(groups[0]?.connectionUrl).toBeNull();
    expect(groups[0]?.incompleteLabels).toEqual(['OLD_DATABASE_URL']);
  });

  it('schema Prisma diverso nello stesso database: gruppi diversi, e non «in uso»', () => {
    const env = {
      DATABASE_URL: url(A_POOLED, '?sslmode=require&schema=public'),
      OLD_DATABASE_URL: url(A_DIRECT, '?sslmode=require&schema=vecchio'),
      LEGACY_DATABASE_URL: url(A_DIRECT, '?sslmode=require&schema=Vecchio'),
      SOLCO_DATABASE_URL: url(A_DIRECT),
    };
    const { groups } = groupLegacySources(env, SECRET);
    expect(groups.map((group) => [group.envNames, group.current])).toEqual([
      // "public" esplicito e assente sono lo stesso schema (quello predefinito di Prisma).
      [['SOLCO_DATABASE_URL', 'DATABASE_URL'], true],
      [['OLD_DATABASE_URL'], false],
      // Postgres distingue le maiuscole negli schemi tra virgolette (come li usa Prisma).
      [['LEGACY_DATABASE_URL'], false],
    ]);
    const old = groups[1];
    expect(old?.connectionUrl).toContain('schema=vecchio');
    expect(new Set(groups.map((group) => group.key)).size).toBe(3);
  });

  it('lo schema predefinito non cambia l’identità (stesse chiavi di prima)', () => {
    const base = { host: A_DIRECT, port: 5432, database: 'neondb', user: 'u' };
    expect(identityString({ ...base, schema: 'public' })).toBe(`${A_DIRECT}\n5432\nneondb\nu`);
    expect(identityString({ ...base, schema: 'vecchio' })).toBe(
      `${A_DIRECT}\n5432\nneondb\nu\nvecchio`,
    );
  });

  it('caratteri di controllo in utente, database o schema: variabile scartata', () => {
    const { groups, skipped } = groupLegacySources(
      {
        OLD_DATABASE_URL: `postgresql://u%0Avecchio:pw@${B_DIRECT}/neondb`,
        LEGACY_DATABASE_URL: `postgresql://u:pw@${B_DIRECT}/neondb?schema=a%0Ab`,
      },
      SECRET,
    );
    expect(groups).toEqual([]);
    expect(skipped).toEqual([
      { name: 'OLD_DATABASE_URL', reason: 'invalid' },
      { name: 'LEGACY_DATABASE_URL', reason: 'invalid' },
    ]);
  });

  it('normalizza l’host togliendo solo il "-pooler" di Neon', () => {
    expect(normalizeHost(`${A_POOLED.toUpperCase()}.`)).toBe(A_DIRECT);
    expect(normalizeHost('db.example.com')).toBe('db.example.com');
  });
});

describe('URL di connessione', () => {
  it('forza TLS, una connessione e i timeout; credenziali intatte; pgbouncer sui pooler', () => {
    const built = buildConnectionUrl(
      'postgresql://us%40er:p%23ss@h.example.com:6543/db?sslmode=disable&connection_limit=50&options=endpoint%3Dabc',
      true,
    );
    expect(built.startsWith('postgresql://us%40er:p%23ss@h.example.com:6543/db?')).toBe(true);
    const params = new URLSearchParams(built.split('?')[1]);
    expect(params.get('sslmode')).toBe('require');
    expect(params.get('connection_limit')).toBe('1');
    expect(params.get('connect_timeout')).toBe('5');
    expect(params.get('pool_timeout')).toBe('5');
    expect(params.get('pgbouncer')).toBe('true');
    expect(params.get('options')).toBe('endpoint=abc');
  });
});

describe('fornitore senza host', () => {
  it.each([
    [A_DIRECT, 'Neon · eu-central-1'],
    ['ep-x.eastus2.azure.neon.tech', 'Neon · eastus2'],
    ['ep-x.us-east-1.postgres.vercel-storage.com', 'Vercel Postgres (Neon) · us-east-1'],
    [C_HOST, 'AWS RDS · eu-west-1'],
    ['db.abcdefgh.supabase.co', 'Supabase'],
    ['dpg-xyz.frankfurt-postgres.render.com', 'Render'],
    ['10.0.0.12', 'altro'],
    ['db.mio-server.it', 'altro'],
  ])('%s → %s', (host, hint) => {
    const result = providerHint(host);
    expect(result).toBe(hint);
    expect(result).not.toContain(host);
  });
});

describe('categorie di errore (mai il testo)', () => {
  it.each([
    [{ name: 'PrismaClientInitializationError', errorCode: 'P1000', message: 'x' }, 'auth'],
    [{ name: 'PrismaClientInitializationError', errorCode: 'P1001', message: 'x' }, 'unreachable'],
    [{ name: 'PrismaClientInitializationError', errorCode: 'P1003', message: 'x' }, 'not_found'],
    [{ name: 'PrismaClientInitializationError', errorCode: 'P1011', message: 'x' }, 'ssl'],
    [{ name: 'PrismaClientKnownRequestError', code: 'P2024', message: 'x' }, 'timeout'],
    [
      {
        name: 'PrismaClientKnownRequestError',
        code: 'P2010',
        meta: { code: '57014' },
        message: '',
      },
      'timeout',
    ],
    [{ code: 'P2010', meta: { code: '28P01' }, message: '' }, 'auth'],
    [{ message: 'Error opening a TLS connection: bad certificate' }, 'ssl'],
    [{ message: "Can't reach database server at ep-x.neon.tech:5432" }, 'unreachable'],
    [new LegacyDeadlineError(), 'timeout'],
    [new LegacyTooLargeError(), 'too_large'],
    ['stringa', 'unknown'],
    [{ message: 'qualcos’altro' }, 'unknown'],
  ])('%#', (error, kind) => {
    expect(legacyErrorKind(error)).toBe(kind);
  });
});

describe('password: formato di better-auth', () => {
  it('un hash creato dall’accesso attuale è compatibile e verificabile', async () => {
    const hash = await hashPassword('Password-di-prova-1');
    expect(isCompatiblePasswordHash(hash)).toBe(true);
    expect(await verifyPassword({ hash, password: 'Password-di-prova-1' })).toBe(true);
  });

  it.each([
    '$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234',
    '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
    'password-in-chiaro',
    '',
    `${'A'.repeat(32)}:${'b'.repeat(128)}`,
    `${'a'.repeat(32)}:${'b'.repeat(64)}`,
    null,
  ])('%s non è compatibile', (value) => {
    expect(isCompatiblePasswordHash(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Piano
// ---------------------------------------------------------------------------------------------

const GOOD_HASH = `${'a1'.repeat(16)}:${'b2'.repeat(64)}`;

function legacyUser(id: string, patch: Partial<LegacyUserRow> = {}): LegacyUserRow {
  return {
    id,
    name: `Utente ${id}`,
    email: `${id}@example.com`,
    emailVerified: true,
    image: null,
    role: 'user',
    banned: false,
    banReason: null,
    banExpires: null,
    phoneNumber: null,
    phoneNumberVerified: false,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-02-01T00:00:00.000Z'),
    ...patch,
  };
}

function credential(userId: string, password: string | null = GOOD_HASH): LegacyAccountRow {
  return {
    userId,
    providerId: 'credential',
    accountId: userId,
    password,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  };
}

function oauth(userId: string, providerId = 'google', accountId = `g-${userId}`): LegacyAccountRow {
  return { ...credential(userId, null), providerId, accountId };
}

function state(patch: Partial<Record<keyof CurrentState, string[]>> = {}): CurrentState {
  return {
    existingEmails: new Set(patch.existingEmails ?? []),
    takenIds: new Set(patch.takenIds ?? []),
    takenPhones: new Set(patch.takenPhones ?? []),
    takenOAuth: new Set(patch.takenOAuth ?? []),
    importedLegacyIds: new Set(patch.importedLegacyIds ?? []),
    reservedEmails: new Set(patch.reservedEmails ?? []),
    reservedIds: new Set(patch.reservedIds ?? []),
  };
}

let counter = 0;
const fixedId = () => `nuovo-id-${++counter}`;

describe('piano di trasferimento', () => {
  it('email già presente (maiuscole e spazi a parte) → saltata, mai unita', () => {
    const plan = buildLegacyPlan(
      { users: [legacyUser('u1', { email: '  Mario.Rossi@Example.COM ' })], accounts: [] },
      state({ existingEmails: ['mario.rossi@example.com'] }),
      NOW,
    );
    expect(plan.toImport).toEqual([]);
    expect(plan.counts.alreadyPresent).toBe(1);
    expect(plan.counts.importable).toBe(0);
  });

  it('email doppia nel vecchio database: vince l’account più vecchio', () => {
    const plan = buildLegacyPlan(
      {
        users: [
          legacyUser('nuovo', { email: 'a@x.it', createdAt: new Date('2025-06-01T00:00:00Z') }),
          legacyUser('vecchio', { email: 'A@X.it', createdAt: new Date('2024-06-01T00:00:00Z') }),
        ],
        accounts: [],
      },
      state(),
      NOW,
    );
    expect(plan.toImport.map((p) => p.legacyId)).toEqual(['vecchio']);
    expect(plan.toImport[0]?.user.email).toBe('a@x.it');
    expect(plan.counts.duplicateInSource).toBe(1);
  });

  it('il ruolo è sempre "user", anche per gli admin del vecchio sito', () => {
    const plan = buildLegacyPlan(
      {
        users: [
          legacyUser('admin1', { role: 'admin' }),
          legacyUser('admin2', { role: 'user, admin' }),
          legacyUser('u3'),
        ],
        accounts: [],
      },
      state(),
      NOW,
    );
    expect(plan.toImport.map((p) => p.user.role)).toEqual(['user', 'user', 'user']);
    expect(plan.counts.legacyAdmins).toBe(2);
    expect(plan.counts.adminsToDemote).toBe(2);
  });

  it('immagine solo https e senza credenziali', () => {
    expect(safeImageUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(safeImageUrl('http://cdn.example.com/a.png')).toBeNull();
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageUrl('https://user:pw@cdn.example.com/a.png')).toBeNull();
    expect(safeImageUrl(`https://cdn.example.com/${'a'.repeat(3000)}`)).toBeNull();
    const plan = buildLegacyPlan(
      {
        users: [
          legacyUser('u1', { image: 'http://insicura.example.com/a.png' }),
          legacyUser('u2', { image: 'https://ok.example.com/b.png' }),
        ],
        accounts: [],
      },
      state(),
      NOW,
    );
    expect(plan.toImport.map((p) => p.user.image)).toEqual([null, 'https://ok.example.com/b.png']);
  });

  it('telefono: solo E.164 verificato e libero; altrimenti tolto (conflitto → tolto)', () => {
    const plan = buildLegacyPlan(
      {
        users: [
          legacyUser('libero', { phoneNumber: '+393331112222', phoneNumberVerified: true }),
          legacyUser('preso', { phoneNumber: '+393339998888', phoneNumberVerified: true }),
          legacyUser('nonverificato', { phoneNumber: '+393334445555', phoneNumberVerified: false }),
          legacyUser('invalido', { phoneNumber: '333 12', phoneNumberVerified: true }),
        ],
        accounts: [credential('libero'), credential('preso'), credential('nonverificato')],
      },
      state({ takenPhones: ['+393339998888'] }),
      NOW,
    );
    const phones = Object.fromEntries(
      plan.toImport.map((p) => [p.legacyId, [p.user.phoneNumber, p.user.phoneNumberVerified]]),
    );
    expect(phones).toEqual({
      libero: ['+393331112222', true],
      preso: [null, null],
      nonverificato: [null, null],
      invalido: [null, null],
    });
    expect(plan.counts.withPhone).toBe(4);
    expect(plan.counts.phonesDropped).toBe(3);
  });

  it('account creato col telefono senza un numero trasferibile: saltato (nessun modo di accedere)', () => {
    const plan = buildLegacyPlan(
      {
        users: [
          legacyUser('tel-ok', {
            email: '393331112222@telefono.solcomusic.invalid',
            phoneNumber: '+393331112222',
            phoneNumberVerified: true,
          }),
          legacyUser('tel-preso', {
            email: '393339998888@telefono.solcomusic.invalid',
            phoneNumber: '+393339998888',
            phoneNumberVerified: true,
          }),
        ],
        accounts: [],
      },
      state({ takenPhones: ['+393339998888'] }),
      NOW,
    );
    expect(plan.toImport.map((p) => [p.legacyId, p.loginMethod])).toEqual([['tel-ok', 'phone']]);
    expect(plan.counts.invalidEmail).toBe(1);
    expect(plan.counts.phoneOnly).toBe(1);
  });

  it('password compatibile copiata; incompatibile o assente → «Password dimenticata»', () => {
    const plan = buildLegacyPlan(
      {
        users: [
          legacyUser('compat'),
          legacyUser('bcrypt'),
          legacyUser('senza'),
          legacyUser('google'),
        ],
        accounts: [
          credential('compat'),
          credential('bcrypt', '$2b$10$abcdefghijklmnopqrstuv'),
          oauth('google'),
        ],
      },
      state(),
      NOW,
    );
    const methods = Object.fromEntries(plan.toImport.map((p) => [p.legacyId, p.loginMethod]));
    expect(methods).toEqual({
      compat: 'password',
      bcrypt: 'reset',
      senza: 'reset',
      google: 'oauth',
    });
    const compat = plan.toImport.find((p) => p.legacyId === 'compat');
    expect(compat?.accounts).toEqual([
      expect.objectContaining({ providerId: 'credential', accountId: null, password: GOOD_HASH }),
    ]);
    expect(plan.toImport.find((p) => p.legacyId === 'bcrypt')?.accounts).toEqual([]);
    expect(plan.counts).toMatchObject({
      importable: 4,
      passwordCompatible: 1,
      passwordIncompatible: 1,
      oauthOnly: 1,
      needsPasswordReset: 2,
    });
  });

  it('OAuth: solo fornitore + id (i token non vengono nemmeno letti); collegamento già usato → saltato', () => {
    const row = parseLegacyAccount({
      userId: 'u1',
      providerId: 'google',
      accountId: 'sub-1',
      accessToken: 'ya29.segreto',
      refreshToken: '1//segreto',
      idToken: 'eyJ.segreto',
      createdAt: '2025-01-01T00:00:00.000',
    });
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain('segreto');
    const plan = buildLegacyPlan(
      {
        users: [legacyUser('u1'), legacyUser('u2')],
        accounts: [
          row as LegacyAccountRow,
          oauth('u2', 'google', 'sub-preso'),
          oauth('u2', 'apple', 'apple-2'),
        ],
      },
      state({ takenOAuth: [oauthKey('google', 'sub-preso')] }),
      NOW,
    );
    const accounts = plan.toImport.flatMap((p) => p.accounts);
    expect(accounts.map((a) => [a.providerId, a.accountId, a.password])).toEqual([
      ['google', 'sub-1', null],
      ['apple', 'apple-2', null],
    ]);
    for (const account of accounts) {
      expect(Object.keys(account).sort()).toEqual([
        'accountId',
        'createdAt',
        'password',
        'providerId',
        'updatedAt',
      ]);
    }
    expect(plan.counts.oauthAccountsSkipped).toBe(1);
  });

  it('id del vecchio sito tenuto se libero, altrimenti nuovo; già importati e email non valide saltati', () => {
    const plan = buildLegacyPlan(
      {
        users: [
          legacyUser('libero'),
          legacyUser('preso'),
          legacyUser('fatto'),
          legacyUser('bad', { email: 'non-una-email' }),
          legacyUser('vuota', { email: null }),
        ],
        accounts: [],
      },
      state({ takenIds: ['preso'], importedLegacyIds: ['fatto'] }),
      NOW,
      fixedId,
    );
    expect(plan.toImport.map((p) => [p.legacyId, p.user.id])).toEqual([
      ['libero', 'libero'],
      ['preso', expect.stringMatching(/^nuovo-id-/)],
    ]);
    expect(plan.counts).toMatchObject({ alreadyImported: 1, invalidEmail: 2, importable: 2 });
  });

  it('identità che il sito promuove ad admin da solo: email saltate, id mai tenuto', async () => {
    // Il meccanismo, con un'email designata di prova.
    const DESIGNATED = 'admin-designato@example.com';
    const reserved = reservedAdminIdentities(
      { POLSIA_OWNER_EMAIL: ' Proprietario@Example.com ', ADMIN_USER_ID: ' id-admin ' },
      DESIGNATED,
    );
    expect([...reserved.emails].sort()).toEqual([DESIGNATED, 'proprietario@example.com'].sort());
    expect([...reserved.ids]).toEqual(['id-admin']);
    expect([...reservedAdminIdentities({}, DESIGNATED).emails]).toEqual([DESIGNATED]);
    // In produzione l'admin designato per email è l'account del proprietario: la sua email è riservata.
    expect(REQUESTED_ADMIN_EMAIL).toBe('bestmr12@icloud.com');
    expect([...reservedAdminIdentities({}).emails]).toEqual(['bestmr12@icloud.com']);
    expect(reservedAdminIdentities({}).ids.size).toBe(0);
    // Senza email designata: nessuna email riservata.
    expect(reservedAdminIdentities({}, null).emails.size).toBe(0);

    const plan = buildLegacyPlan(
      {
        users: [
          // Email dell'admin richiesto, in maiuscolo, NON verificata, con password compatibile.
          legacyUser('richiesto', {
            email: DESIGNATED.toUpperCase(),
            emailVerified: false,
          }),
          legacyUser('proprietario', { email: 'PROPRIETARIO@example.com', role: 'admin' }),
          legacyUser('id-admin'),
          legacyUser('normale'),
        ],
        accounts: [credential('richiesto'), credential('proprietario'), credential('id-admin')],
      },
      {
        ...state(),
        reservedEmails: reserved.emails,
        reservedIds: reserved.ids,
      },
      NOW,
      fixedId,
    );
    expect(plan.toImport.map((p) => p.legacyId)).toEqual(['id-admin', 'normale']);
    expect(plan.counts).toMatchObject({ reservedAdmin: 2, importable: 2, adminsToDemote: 0 });
    expect(JSON.stringify(plan.toImport)).not.toContain(DESIGNATED);

    // L'id riservato non viene tenuto: nessun hook lo riconosce come l'admin designato.
    const kept = plan.toImport.find((p) => p.legacyId === 'id-admin');
    expect(kept?.user.id).toMatch(/^nuovo-id-/);
    expect(
      resolveInitialSignupRole(
        { id: kept?.user.id ?? '', email: kept?.user.email, emailVerified: true },
        'id-admin',
      ),
    ).toBe('user');

    // Il seed promuove la riga con l'email richiesta: nessuna riga creata, nessuna promozione.
    const created = plan.toImport.find((p) => p.user.email === DESIGNATED);
    const updates: unknown[] = [];
    await normalizePersistedAdminRoles(
      { updateMany: async (args) => updates.push(args) },
      created?.user.id,
    );
    expect(updates).toEqual([]);
  });

  it('conserva blocco, verifica e date; nome vuoto → nome generico', () => {
    const banExpires = new Date('2027-01-01T00:00:00.000Z');
    const plan = buildLegacyPlan(
      {
        users: [
          legacyUser('b', {
            name: '   ',
            banned: true,
            banReason: 'spam',
            banExpires,
            emailVerified: false,
          }),
        ],
        accounts: [],
      },
      state(),
      NOW,
    );
    expect(plan.toImport[0]?.user).toMatchObject({
      name: 'Ascoltatore Solco',
      banned: true,
      banReason: 'spam',
      banExpires,
      emailVerified: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-02-01T00:00:00.000Z'),
    });
    expect(plan.counts).toMatchObject({ banned: 1, verified: 0 });
  });

  it('righe JSON del vecchio database: date senza fuso lette come UTC, colonne mancanti tollerate', () => {
    expect(parseLegacyDate('2024-05-01T10:00:00.123')?.toISOString()).toBe(
      '2024-05-01T10:00:00.123Z',
    );
    expect(parseLegacyDate('2024-05-01T12:00:00+02:00')?.toISOString()).toBe(
      '2024-05-01T10:00:00.000Z',
    );
    expect(parseLegacyDate('boh')).toBeNull();
    // Valori guasti fuori intervallo: niente data (non sarebbero ISO validi nel contratto).
    expect(parseLegacyDate('+275760-09-13T00:00:00.000Z')).toBeNull();
    expect(parseLegacyDate('1900-01-01T00:00:00.000')).toBeNull();
    expect(
      parseLegacyUser({ id: 'x', email: 'x@y.it', emailVerified: true, createdAt: '2024-01-01' }),
    ).toMatchObject({ id: 'x', role: null, phoneNumber: null, banned: false });
    expect(parseLegacyUser({ email: 'senza-id@y.it' })).toBeNull();
  });

  it('lookupKeys: email normalizzate, id sicuri, telefoni E.164, account OAuth', () => {
    const keys = lookupKeys({
      users: [legacyUser('u1', { email: ' U1@Example.com', phoneNumber: '+393331112222' })],
      accounts: [credential('u1'), oauth('u1')],
    });
    expect(keys).toEqual({
      emails: ['u1@example.com'],
      ids: ['u1'],
      phones: ['+393331112222'],
      accountIds: ['g-u1'],
    });
  });
});

describe('gettone dell’anteprima', () => {
  const source = 'a'.repeat(32);
  const ids = ['u1', 'u2', 'u3'];

  it('firma e verifica: nessun id in chiaro, copre lo stesso insieme o uno più piccolo', () => {
    const { token, expiresAt } = signPreviewToken({
      sourceKey: source,
      ids,
      secret: SECRET,
      now: 0,
    });
    expect(expiresAt).toBe(new Date(15 * 60 * 1000).toISOString());
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()).not.toContain('u1');
    const verified = verifyPreviewToken(token, { sourceKey: source, secret: SECRET, now: 1000 });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.preview.count).toBe(3);
    expect(verified.preview.digest).toBe(idsDigest(['u3', 'u1', 'u2']));
    expect(previewCovers(verified.preview, ids, SECRET)).toBe(true);
    expect(previewCovers(verified.preview, ['u2'], SECRET)).toBe(true);
    expect(previewCovers(verified.preview, [], SECRET)).toBe(true);
    expect(previewCovers(verified.preview, ['u1', 'nuovo'], SECRET)).toBe(false);
  });

  it('scaduto dopo 15 minuti', () => {
    const { token } = signPreviewToken({ sourceKey: source, ids, secret: SECRET, now: 0 });
    expect(
      verifyPreviewToken(token, { sourceKey: source, secret: SECRET, now: 15 * 60 * 1000 }),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('altra fonte, altro segreto o gettone modificato → non valido', () => {
    const { token } = signPreviewToken({ sourceKey: source, ids, secret: SECRET, now: 0 });
    const check = (t: string, s = source, secret = SECRET) =>
      verifyPreviewToken(t, { sourceKey: s, secret, now: 1 });
    expect(check(token, 'b'.repeat(32))).toEqual({ ok: false, reason: 'invalid' });
    expect(check(token, source, 'altro-segreto')).toEqual({ ok: false, reason: 'invalid' });
    const [body, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body ?? '', 'base64url').toString()),
        exp: 9e15,
      }),
    ).toString('base64url');
    expect(check(`${forged}.${signature}`)).toEqual({ ok: false, reason: 'invalid' });
    expect(check(`${body}.${signature}x`)).toEqual({ ok: false, reason: 'invalid' });
    expect(check('abc')).toEqual({ ok: false, reason: 'invalid' });
  });
});
