// @polsia:user-owned
// @vitest-environment node
//
// «Skynet», un giro completo (src/lib/skynet/sentinel.server.ts) con database, Vercel, /health,
// Telegram e Claude finti: legge solo (GET), avvisa solo gli admin verificati collegati a Telegram,
// non manda mai il token Vercel fuori da api.vercel.com, un giro alla volta; il cacciatore e il
// motore post-quantistico (strette di mano finte).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/business/telegram-bot.server', () => ({ sendTelegramMessage: vi.fn() }));
vi.mock('@/lib/monitoring/monitor.server', () => ({
  latestRun: vi.fn(async () => null),
  recordHeartbeat: vi.fn(async () => true),
  STALE_AFTER_MS: 2 * 60 * 60 * 1000,
}));

import type { PqResult } from '@/lib/skynet/quantum';
import {
  type ReportInput,
  runSentinel,
  type SentinelDeps,
  telegramText,
  vercelAccess,
} from '@/lib/skynet/sentinel.server';

const TOKEN = 'vercel-token-di-prova-0123456789';
const ENV = {
  SKYNET_VERCEL_TOKEN: TOKEN,
  SKYNET_VERCEL_PROJECT_ID: 'prj_ProvaProgetto123',
  SKYNET_VERCEL_TEAM_ID: 'team_ProvaTeam456',
  NEXT_PUBLIC_APP_URL: 'https://www.solcomusic.online',
};

type Row = Record<string, unknown>;

/** Database in memoria con solo le operazioni che la sentinella usa. */
function fakeDb() {
  const state = new Map<string, Row>();
  const events: Row[] = [];
  const users = [
    { id: 'admin', role: 'admin', emailVerified: true },
    { id: 'admin-non-verificato', role: 'admin', emailVerified: false },
    { id: 'utente', role: 'user', emailVerified: true },
  ];
  const links = [
    { userId: 'admin', telegramChatId: '111111' },
    { userId: 'admin-non-verificato', telegramChatId: '222222' },
    { userId: 'utente', telegramChatId: '333333' },
  ];
  const lockFree = (row: Row, now: Date) =>
    row.lockedUntil === null || (row.lockedUntil as Date).getTime() < now.getTime();
  const db = {
    skynetState: {
      createMany: async ({ data }: { data: Row[] }) => {
        for (const item of data) {
          if (!state.has(item.id as string)) {
            state.set(item.id as string, {
              calmStreak: 0,
              incidentSince: null,
              incidentKeys: [],
              lastNotifiedAt: null,
              firewallVersion: null,
              lastSignals: null,
              lockedUntil: null,
              ...item,
            });
          }
        }
        return { count: data.length };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.get(where.id as string);
        if (!row) return { count: 0 };
        if (where.OR) {
          const now = new Date((data.lockedUntil as Date).getTime() - 50_000);
          if (!lockFree(row, now)) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: Row }) => state.get(where.id as string) ?? null,
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.get(where.id as string);
        Object.assign(row ?? {}, data);
        return row;
      },
    },
    skynetEvent: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `e${events.length + 1}`, notified: 0, ...data };
        events.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        Object.assign(events.find((e) => e.id === where.id) ?? {}, data);
      },
      findMany: async () => [...events].reverse(),
    },
    user: {
      findMany: async () => users.filter((u) => u.role.includes('admin') && u.emailVerified),
    },
    telegramAccountLink: {
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
        links.filter((l) => where.userId.in.includes(l.userId)),
    },
  };
  return { db, state, events };
}

type Site = {
  anomalies: number;
  firewallEnabled: boolean;
  version: number;
  health: number;
  attackMode: boolean;
  /** Registro dei blocchi persistenti (come lo restituisce Vercel: public_ip, istante UTC). */
  blocks: Array<{ public_ip: string; ruleName: string; count: number; startTime?: string }>;
  ips: Array<{ id: string; ip: string; hostname: string; action: string; notes?: string }>;
  patches: Array<Record<string, unknown>>;
};

function fakeFetch(site: Site, calls: Array<{ url: string; auth: string | null; method: string }>) {
  return async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url: input, auth: headers.get('authorization'), method: init.method ?? 'GET' });
    const url = new URL(input);
    if (url.host === 'api.vercel.com') {
      if (headers.get('authorization') !== `Bearer ${TOKEN}`)
        return new Response('no', { status: 403 });
      if (url.pathname.endsWith('/attack-status')) {
        return Response.json({
          anomalies: Array.from({ length: site.anomalies }, (_, i) => ({ id: i })),
        });
      }
      if (url.pathname.endsWith('/config/active')) {
        return Response.json({
          firewallEnabled: site.firewallEnabled,
          version: site.version,
          managedRules: { ai_bots: { active: true, action: 'deny' } },
          rules: [
            { name: 'Skynet · sonde e scanner', active: true },
            { name: 'Skynet · AI dichiarate', active: true },
            { name: 'Skynet · SMS, registrazioni e recupero', active: true },
            { name: 'Skynet · browser automatici', active: true },
            { name: 'Limite richieste API per IP', active: true },
          ],
          ips: site.ips,
        });
      }
      if (url.pathname === '/v1/security/firewall/events') {
        return Response.json({ actions: site.blocks, pagination: { hasMore: false, next: null } });
      }
      if (url.pathname === '/v1/security/firewall/config' && init.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        site.patches.push(body);
        const value = body.value as Record<string, string> | null;
        if (body.action === 'ip.insert' && value) {
          site.ips.push({ id: `ip_${site.ips.length + 1}`, ...value } as Site['ips'][number]);
        }
        if (body.action === 'ip.update' && value) {
          site.ips = site.ips.map((r) => (r.id === body.id ? { ...r, ...value } : r));
        }
        if (body.action === 'ip.remove') site.ips = site.ips.filter((r) => r.id !== body.id);
        site.version += 1;
        return Response.json({});
      }
      if (url.pathname.startsWith('/v9/projects/')) {
        return Response.json({ security: { attackModeEnabled: site.attackMode } });
      }
    }
    if (input === 'https://www.solcomusic.online/health') {
      return site.health === 200
        ? Response.json({ status: 'healthy' })
        : new Response('down', { status: site.health });
    }
    return new Response('?', { status: 404 });
  };
}

let site: Site;
let calls: Array<{ url: string; auth: string | null; method: string }>;
let fake: ReturnType<typeof fakeDb>;
let sent: Array<{ chat: string; html: string }>;
let reports: ReportInput[];
let heartbeats: string[];
let minute: number;

function deps(overrides: Partial<SentinelDeps> = {}): Partial<SentinelDeps> {
  return {
    db: fake.db as unknown as SentinelDeps['db'],
    env: ENV,
    fetch: fakeFetch(site, calls),
    now: () => new Date(Date.UTC(2026, 10, 17, 21, minute)),
    clock: () => 0,
    latestRun: async () => null,
    heartbeat: async (detail) => {
      heartbeats.push(detail);
    },
    sendTelegram: async (chat, html) => {
      sent.push({ chat, html });
      return true;
    },
    writeReport: async (input) => {
      reports.push(input);
      return 'Rapporto di Claude: traffico anomalo, valuti la protezione anti-attacco.';
    },
    // Runtime senza ML-KEM: il motore post-quantistico resta muto dove non è lui il soggetto.
    probeQuantum: async () => 'unsupported',
    ...overrides,
  };
}

async function tick(overrides: Partial<SentinelDeps> = {}) {
  const result = await runSentinel(deps(overrides));
  minute += 1;
  return result;
}

beforeEach(() => {
  site = {
    anomalies: 0,
    firewallEnabled: true,
    version: 14,
    health: 200,
    attackMode: false,
    blocks: [],
    ips: [],
    patches: [],
  };
  calls = [];
  fake = fakeDb();
  sent = [];
  reports = [];
  heartbeats = [];
  minute = 0;
});

describe('Skynet, un giro', () => {
  it('tutto tranquillo: nessun avviso, solo letture, battito e stato salvati, turno liberato', async () => {
    const result = await tick();
    expect(result).toEqual({
      ran: true,
      status: 'calm',
      decision: 'none',
      problems: [],
      notified: 0,
      vercel: 'ok',
      hunted: 0,
      quantum: null,
    });
    expect(sent).toEqual([]);
    expect(fake.events).toEqual([]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(heartbeats[0]).toMatch(
      /^Tranquillo · Vercel: 0 anomalie, firewall v14 · \/health 0 ms$/,
    );
    const row = fake.state.get('main');
    expect(row?.lockedUntil).toBeNull();
    expect(row?.lastSignals).toMatchObject({
      vercel: { firewallVersion: 14, skynetRulesActive: 4 },
    });
  });

  it('il token Vercel va solo ad api.vercel.com, mai a /health né a Claude', async () => {
    site.anomalies = 1;
    await tick();
    for (const call of calls) {
      expect(call.auth === null || new URL(call.url).host === 'api.vercel.com').toBe(true);
    }
    expect(JSON.stringify(reports)).not.toContain(TOKEN);
    expect(JSON.stringify(fake.events)).not.toContain(TOKEN);
  });

  it('attacco DDoS: incidente critico, rapporto di Claude, Telegram solo all’admin verificato', async () => {
    site.anomalies = 2;
    const result = await tick();
    expect(result).toMatchObject({ status: 'incident', decision: 'incident', notified: 1 });
    expect(sent.map((m) => m.chat)).toEqual(['111111']);
    expect(sent[0]?.html).toContain('<b>🚨 Skynet · incidente critico</b>');
    expect(sent[0]?.html).toContain('Vercel rileva 2 anomalie di traffico');
    expect(sent[0]?.html).toContain('Rapporto di Claude');
    expect(sent[0]?.html).toContain('https://www.solcomusic.online/admin/monitoraggio');
    expect(fake.events).toMatchObject([
      { kind: 'incident', severity: 'critical', keys: ['ddos'], notified: 1 },
    ]);
    expect(reports[0]).toMatchObject({ kind: 'incident', problems: [{ key: 'ddos' }] });
  });

  it('niente doppioni: lo stesso incidente non riscrive a ogni minuto, e si chiude dopo 3 giri calmi', async () => {
    site.anomalies = 1;
    await tick();
    await tick();
    await tick();
    expect(sent).toHaveLength(1);
    site.anomalies = 0;
    await tick();
    await tick();
    const closed = await tick();
    expect(closed).toMatchObject({ status: 'calm', decision: 'resolved' });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.html).toContain('✅ Skynet · tutto tornato normale');
    expect(fake.events.map((e) => e.kind)).toEqual(['incident', 'resolved']);
  });

  it('sito giù: avviso solo al secondo giro di fila', async () => {
    site.health = 503;
    await tick();
    expect(sent).toEqual([]);
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.html).toContain('/health risponde HTTP 503');
  });

  it('firewall modificato: un avviso informativo (versione 14 → 15)', async () => {
    await tick();
    site.version = 15;
    await tick();
    expect(fake.events).toMatchObject([
      {
        kind: 'change',
        severity: 'info',
        title: 'Firewall di Vercel modificato: versione 14 → 15',
      },
    ]);
    expect(sent[0]?.html).toContain('⚙️ Skynet · firewall modificato');
  });

  it('Claude non disponibile: rapporto di riserva con le azioni da fare', async () => {
    site.anomalies = 1;
    await tick({ writeReport: async () => null });
    expect(sent[0]?.html).toContain('Cosa fare:');
    expect(sent[0]?.html).toContain('Attack Challenge Mode');
  });

  it('senza token: nessuna chiamata a Vercel, nessun falso allarme', async () => {
    const result = await tick({ env: { NEXT_PUBLIC_APP_URL: ENV.NEXT_PUBLIC_APP_URL } });
    expect(result).toMatchObject({ ran: true, vercel: 'off', problems: [] });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['www.solcomusic.online']);
    expect(heartbeats[0]).toContain('Vercel: manca il token');
  });

  it('SKYNET_TELEGRAM_CHAT_IDS sceglie le chat al posto del database', async () => {
    site.anomalies = 1;
    await tick({ env: { ...ENV, SKYNET_TELEGRAM_CHAT_IDS: '987654, abc, 987654' } });
    expect(sent.map((m) => m.chat)).toEqual(['987654']);
  });

  it('un giro alla volta: se il turno è preso, il secondo non legge nulla', async () => {
    await fake.db.skynetState.createMany({
      data: [{ id: 'main', updatedAt: new Date(), streaks: {} }],
    });
    const row = fake.state.get('main');
    if (row) row.lockedUntil = new Date(Date.UTC(2026, 10, 17, 22, 0));
    const result = await tick();
    expect(result.ran).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('Skynet, il cacciatore', () => {
  const SCANNER = 'Skynet · sonde e scanner';
  const LOGIN = 'Accesso: limite tentativi';
  /** Istante nel formato del registro di Vercel, `minutes` minuti dopo le 21:00 del giro 0. */
  const at = (minutes: number) =>
    new Date(Date.UTC(2026, 10, 17, 21, minutes)).toISOString().replace('T', ' ').replace('Z', '');

  it('sonda da scanner: verifica al primo blocco su tutti gli host, nel diario; un tentativo d’accesso da solo no', async () => {
    site.blocks = [
      { public_ip: '203.0.113.77', ruleName: SCANNER, count: 1, startTime: at(-30) },
      { public_ip: '198.51.100.5', ruleName: LOGIN, count: 1, startTime: at(-20) },
    ];
    const result = await tick();
    expect(result.hunted).toBe(1);
    expect(site.patches).toEqual([
      {
        action: 'ip.insert',
        id: null,
        value: {
          ip: '203.0.113.77',
          hostname: '*',
          action: 'challenge',
          notes: 'Skynet · verifica fino al 2026-11-18T21:00:00.000Z',
        },
      },
    ]);
    // Una verifica di routine resta nel diario del pannello: niente Telegram.
    expect(sent).toEqual([]);
    expect(fake.events).toMatchObject([
      {
        kind: 'hunt',
        severity: 'warning',
        title: '1 indirizzo rimandato alla verifica per 24 ore',
        notified: 0,
      },
    ]);
    expect(fake.events[0]?.report).toContain(
      '203.0.x.x: sonde da scanner ×1 → verifica per 24 ore',
    );
    // Mai l'indirizzo intero nel diario.
    expect(JSON.stringify(fake.events)).not.toContain('203.0.113.77');
    expect(fake.state.get('main')?.lastSignals).toMatchObject({
      vercel: { hunted: 1, huntedLong: 0 },
    });
    // Il registro si legge per intero: 24 ore con inizio E fine (senza fine Vercel dà solo i
    // blocchi ancora in corso).
    const events = calls.find((c) => c.url.includes('/v1/security/firewall/events'));
    expect(events?.url).toMatch(/startTimestamp=\d+&endTimestamp=\d+/);
  });

  it('ondata (5 nuovi in un giro): avviso su Telegram, indirizzi mascherati', async () => {
    site.blocks = [1, 2, 3, 4, 5].map((n) => ({
      public_ip: `203.0.113.${n}`,
      ruleName: SCANNER,
      count: 1,
      startTime: at(-n),
    }));
    await tick();
    expect(site.patches).toHaveLength(5);
    expect(sent.map((m) => m.chat)).toEqual(['111111']);
    expect(sent[0]?.html).toContain('🛡️ Skynet · hacker rimandati alla verifica');
    expect(sent[0]?.html).toContain('5 indirizzi rimandati alla verifica per 24 ore');
    expect(sent[0]?.html).toContain('203.0.x.x: sonde da scanner ×1 → verifica per 24 ore');
    expect(sent[0]?.html).not.toContain('203.0.113.');
  });

  it('due tentativi d’accesso a raffica in 24 ore: verifica', async () => {
    site.blocks = [
      { public_ip: '198.51.100.5', ruleName: LOGIN, count: 1, startTime: at(-600) },
      { public_ip: '198.51.100.5', ruleName: LOGIN, count: 1, startTime: at(-20) },
    ];
    await tick();
    expect(site.patches).toMatchObject([{ action: 'ip.insert', value: { ip: '198.51.100.5' } }]);
  });

  it('chi attacca durante la verifica: prolungata a 7 giorni, una volta sola e senza «manomissione»', async () => {
    site.ips = [
      {
        id: 'ip_skynet',
        ip: '203.0.113.77',
        hostname: '*',
        action: 'challenge',
        // Cominciata alle 20:00, un'ora prima del giro.
        notes: 'Skynet · verifica fino al 2026-11-18T20:00:00.000Z',
      },
    ];
    site.blocks = [{ public_ip: '203.0.113.77', ruleName: SCANNER, count: 2, startTime: at(-10) }];
    await tick();
    expect(site.patches).toEqual([
      {
        action: 'ip.update',
        id: 'ip_skynet',
        value: {
          ip: '203.0.113.77',
          hostname: '*',
          action: 'challenge',
          notes: 'Skynet · verifica fino al 2026-11-24T21:00:00.000Z · livello 2',
        },
      },
    ]);
    expect(sent[0]?.html).toContain('1 verifica prolungata: attaccavano anche durante la verifica');
    expect(sent[0]?.html).toContain(
      '203.0.x.x: ancora all’attacco durante la verifica (sonde da scanner ×2) → prolungata a 7 giorni',
    );
    expect(fake.state.get('main')?.lastSignals).toMatchObject({
      vercel: { hunted: 1, huntedLong: 1 },
    });
    // Al giro dopo lo stesso blocco è di prima del prolungamento: niente doppioni, niente avviso
    // di firewall modificato per le modifiche di Skynet.
    await tick();
    expect(site.patches).toHaveLength(1);
    expect(fake.events.map((e) => e.kind)).toEqual(['hunt']);
  });

  it('IPv6: la verifica va a tutta la rete /64', async () => {
    site.blocks = [
      { public_ip: '2001:db8:85a3:7::1', ruleName: SCANNER, count: 1, startTime: at(-5) },
    ];
    await tick();
    expect(site.patches).toMatchObject([
      { action: 'ip.insert', value: { ip: '2001:db8:85a3:7::/64', action: 'challenge' } },
    ]);
    expect(fake.events[0]?.report).toContain('2001:db8:…/64');
    expect(JSON.stringify(fake.events)).not.toContain('85a3:7::');
  });

  it('le modifiche di Skynet non sembrano manomissioni al giro dopo', async () => {
    site.blocks = [{ public_ip: '203.0.113.77', ruleName: SCANNER, count: 2, startTime: at(-5) }];
    await tick();
    await tick();
    expect(fake.events.map((e) => e.kind)).toEqual(['hunt']);
    expect(site.patches).toHaveLength(1);
  });

  it('alla scadenza toglie solo le regole Skynet tranquille, mai quelle messe a mano', async () => {
    site.ips = [
      {
        id: 'ip_skynet',
        ip: '203.0.113.9',
        hostname: '*',
        action: 'challenge',
        notes: 'Skynet · verifica fino al 2026-11-17T20:00:00.000Z',
      },
      {
        id: 'ip_manuale',
        ip: '198.51.100.9',
        hostname: '*',
        action: 'deny',
        notes: 'bloccato a mano',
      },
    ];
    await tick();
    expect(site.patches).toEqual([{ action: 'ip.remove', id: 'ip_skynet', value: null }]);
    expect(site.ips.map((r) => r.id)).toEqual(['ip_manuale']);
    expect(sent).toEqual([]);
  });

  it('un solo tentativo d’accesso o regole di solo traffico: nessuna azione', async () => {
    site.blocks = [
      { public_ip: '203.0.113.1', ruleName: LOGIN, count: 1, startTime: at(-5) },
      {
        public_ip: '203.0.113.2',
        ruleName: 'Limite richieste API per IP',
        count: 7,
        startTime: at(-5),
      },
    ];
    const result = await tick();
    expect(result.hunted).toBe(0);
    expect(site.patches).toEqual([]);
  });

  it('senza token il cacciatore non fa nulla', async () => {
    site.blocks = [{ public_ip: '203.0.113.77', ruleName: SCANNER, count: 5, startTime: at(-5) }];
    const result = await tick({ env: { NEXT_PUBLIC_APP_URL: ENV.NEXT_PUBLIC_APP_URL } });
    expect(result.hunted).toBe(0);
    expect(site.patches).toEqual([]);
  });
});

describe('Skynet, il motore post-quantistico', () => {
  const WWW = 'www.solcomusic.online';
  const APEX = 'solcomusic.online';

  function probeWith(results: Record<string, PqResult>, probed: string[] = []) {
    return async (host: string) => {
      probed.push(host);
      return results[host] ?? 'unreachable';
    };
  }

  it('domini protetti: «acceso» una volta sola, poi un controllo all’ora senza doppioni', async () => {
    const probed: string[] = [];
    const probeQuantum = probeWith({ [WWW]: 'pq', [APEX]: 'pq' }, probed);
    const first = await tick({ probeQuantum });
    expect(first.quantum).toBe(true);
    expect(probed).toEqual([WWW, APEX]);
    expect(fake.events).toMatchObject([
      {
        kind: 'quantum',
        severity: 'info',
        title: 'Motore post-quantistico acceso: connessioni protette con X25519MLKEM768',
        notified: 1,
      },
    ]);
    expect(sent.map((m) => m.chat)).toEqual(['111111']);
    expect(sent[0]?.html).toContain('<b>⚛️ Skynet · motore post-quantistico</b>');
    expect(sent[0]?.html).toContain('NIST FIPS 203');
    expect(heartbeats[0]).toContain('post-quantistico ✓');
    expect(fake.state.get('main')?.lastSignals).toMatchObject({
      quantum: { pq: true, announced: 'on', hosts: [{ host: WWW, result: 'pq' }, { host: APEX }] },
    });
    // Nessuna richiesta HTTP verso i domini oltre a /health: il motore usa solo strette di mano.
    expect(
      calls.filter((c) => !c.url.startsWith('https://api.vercel.com/')).map((c) => c.url),
    ).toEqual(['https://www.solcomusic.online/health']);

    const second = await tick({ probeQuantum });
    expect(second.quantum).toBe(true);
    expect(probed).toHaveLength(2);

    minute += 60;
    await tick({ probeQuantum });
    expect(probed).toHaveLength(4);
    expect(fake.events).toHaveLength(1);
  });

  it('post-quantistico rifiutato: avviso dopo 3 controlli di fila, poi «di nuovo attiva», mai un incidente', async () => {
    const results: Record<string, PqResult> = { [WWW]: 'pq', [APEX]: 'classic-only' };
    const probeQuantum = probeWith(results);
    await tick({ probeQuantum });
    await tick({ probeQuantum });
    expect(fake.events).toEqual([]);
    const third = await tick({ probeQuantum });
    expect(third.quantum).toBe(false);
    expect(fake.events).toMatchObject([
      {
        kind: 'quantum',
        severity: 'warning',
        title: `Connessioni senza protezione post-quantistica: ${APEX}`,
      },
    ]);
    expect(sent[0]?.html).toContain('Settings → Domains');
    expect(heartbeats[2]).toContain('post-quantistico ✗');
    await tick({ probeQuantum });
    expect(fake.events).toHaveLength(1);

    results[APEX] = 'pq';
    minute += 60;
    const back = await tick({ probeQuantum });
    expect(back.quantum).toBe(true);
    expect(fake.events.map((e) => e.title)).toEqual([
      `Connessioni senza protezione post-quantistica: ${APEX}`,
      'Protezione post-quantistica di nuovo attiva',
    ]);
    // Il motore avvisa e basta: nessun incidente aperto, nessuna modifica al firewall.
    expect(fake.state.get('main')?.incidentSince).toBeNull();
    expect(site.patches).toEqual([]);
  });

  it('rete, errori o runtime senza ML-KEM: nessun allarme e il giro va avanti', async () => {
    const failing = await tick({
      probeQuantum: async () => {
        throw new Error('rete');
      },
    });
    expect(failing).toMatchObject({ ran: true, quantum: null, status: 'calm' });
    minute += 10;
    const unsupported = await tick({ probeQuantum: async () => 'unsupported' });
    expect(unsupported).toMatchObject({ ran: true, quantum: null });
    expect(fake.events).toEqual([]);
    expect(sent).toEqual([]);
    expect(heartbeats.join('\n')).not.toContain('post-quantistico');
  });

  it('un errore imprevisto del controllo tiene lo stato di prima: nessun «acceso» ripetuto', async () => {
    const probeQuantum = probeWith({ [WWW]: 'pq', [APEX]: 'pq' });
    await tick({ probeQuantum });
    minute += 60;
    const broken = await tick({
      probeQuantum: (() => {
        throw new Error('rotto');
      }) as SentinelDeps['probeQuantum'],
    });
    expect(broken).toMatchObject({ ran: true, quantum: true });
    minute += 60;
    await tick({ probeQuantum });
    expect(fake.events.map((e) => e.kind)).toEqual(['quantum']);
  });

  it('turno preso da un altro giro: nessuna stretta di mano', async () => {
    await fake.db.skynetState.createMany({
      data: [{ id: 'main', updatedAt: new Date(), streaks: {} }],
    });
    const row = fake.state.get('main');
    if (row) row.lockedUntil = new Date(Date.UTC(2026, 10, 17, 22, 0));
    const probed: string[] = [];
    const result = await tick({ probeQuantum: probeWith({ [WWW]: 'pq' }, probed) });
    expect(result).toMatchObject({ ran: false, quantum: null });
    expect(probed).toEqual([]);
  });
});

describe('Skynet, dettagli', () => {
  it('il messaggio Telegram neutralizza l’HTML dei testi', () => {
    const html = telegramText(
      { kind: 'incident', severity: 'warning', title: 'Titolo <script>&' },
      [{ key: 'site-slow', severity: 'warning', title: 'Lento <b>', detail: 'x > y' }],
      'Rapporto con <i>tag</i>',
      'https://www.solcomusic.online',
    );
    expect(html).toContain('Titolo &lt;script&gt;&amp;');
    expect(html).toContain('Lento &lt;b&gt;');
    expect(html).toContain('Rapporto con &lt;i&gt;tag&lt;/i&gt;');
    expect(html).not.toContain('<script>');
  });

  it('accesso a Vercel solo con token e identificativi ben formati', () => {
    expect(vercelAccess(ENV)).toEqual({
      token: TOKEN,
      projectId: 'prj_ProvaProgetto123',
      teamId: 'team_ProvaTeam456',
    });
    expect(vercelAccess({ ...ENV, SKYNET_VERCEL_PROJECT_ID: 'mr120712' })).toBeNull();
    expect(vercelAccess({ ...ENV, SKYNET_VERCEL_TOKEN: 'corto' })).toBeNull();
    expect(vercelAccess({ ...ENV, SKYNET_VERCEL_TEAM_ID: 'team con spazi' })).toBeNull();
    expect(vercelAccess({ ...ENV, SKYNET_VERCEL_TEAM_ID: '' })).toMatchObject({ teamId: null });
  });
});
