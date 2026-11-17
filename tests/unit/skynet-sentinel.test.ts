// @polsia:user-owned
// @vitest-environment node
//
// «Skynet», un giro completo (src/lib/skynet/sentinel.server.ts) con database, Vercel, /health,
// Telegram e Claude finti: legge solo (GET), avvisa solo gli admin verificati collegati a Telegram,
// non manda mai il token Vercel fuori da api.vercel.com, un giro alla volta.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/business/telegram-bot.server', () => ({ sendTelegramMessage: vi.fn() }));
vi.mock('@/lib/monitoring/monitor.server', () => ({
  latestRun: vi.fn(async () => null),
  recordHeartbeat: vi.fn(async () => true),
  STALE_AFTER_MS: 2 * 60 * 60 * 1000,
}));

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
            { name: 'Limite richieste API per IP', active: true },
          ],
        });
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
    ...overrides,
  };
}

async function tick(overrides: Partial<SentinelDeps> = {}) {
  const result = await runSentinel(deps(overrides));
  minute += 1;
  return result;
}

beforeEach(() => {
  site = { anomalies: 0, firewallEnabled: true, version: 14, health: 200, attackMode: false };
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
      vercel: { firewallVersion: 14, skynetRulesActive: 3 },
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
