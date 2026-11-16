// @polsia:user-owned — statistiche di visita: normalizzazione del percorso (niente admin, API,
// query o id), host di provenienza (mai il sito stesso), dispositivo e robot dal browser, impronta
// giornaliera (stessa nel giorno, diversa il giorno dopo, mai l'IP in chiaro), registrazione senza
// dati personali, composizione della risposta con gli zeri, pulizia a 90 giorni.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/site', () => ({ siteUrl: 'https://www.solcomusic.online' }));

import { romeDayKey } from '@/lib/admin/signups';
import {
  buildVisitorStats,
  countryFrom,
  deviceFrom,
  isAutomatedUserAgent,
  normalizeVisitPath,
  referrerHostFrom,
  visitorDayKeys,
  visitRetentionCutoff,
} from '@/lib/admin/visitors';
import {
  getVisitorStats,
  pruneOldVisits,
  recordVisit,
  visitorHashFor,
} from '@/lib/admin/visitors.server';
import { AdminVisitorsSchema, VISITORS_RETENTION_DAYS } from '@/lib/contracts/admin-visitors';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 14:30 UTC = 15:30 a Roma (ora solare a novembre).
const NOW = new Date('2026-11-16T14:30:00.000Z');

function headersOf(values: Record<string, string>) {
  return new Headers(values);
}

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', 'segreto-di-prova-per-le-visite-0123456789abcdef');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('normalizeVisitPath', () => {
  it('tiene i percorsi delle pagine, senza barra finale', () => {
    expect(normalizeVisitPath('/')).toBe('/');
    expect(normalizeVisitPath('/search')).toBe('/search');
    expect(normalizeVisitPath('/search/')).toBe('/search');
    expect(normalizeVisitPath(' /guida ')).toBe('/guida');
    expect(normalizeVisitPath('/generi/techno')).toBe('/generi/techno');
  });

  it('raggruppa gli id dopo il primo segmento con «*»', () => {
    expect(normalizeVisitPath('/playlist/clx123abc')).toBe('/playlist/*');
    expect(normalizeVisitPath('/profiles/u-77/followers')).toBe('/profiles/*');
    expect(normalizeVisitPath('/evidenza/Pop/Autrice%20-%20Canzone.mp3')).toBe('/evidenza/*');
    expect(normalizeVisitPath('/quiz/abc')).toBe('/quiz/*');
  });

  it('non conta amministrazione, API, asset e percorsi strani', () => {
    for (const path of [
      '/admin',
      '/admin/iscritti',
      '/api/visits',
      '/_next/static/x.js',
      '/search?q=solco',
      '/a b',
      '//x',
      '/../x',
      '/x/./y',
      'search',
      '',
      `/${'a'.repeat(200)}`,
      'https://www.solcomusic.online/',
    ]) {
      expect(normalizeVisitPath(path), path).toBeNull();
    }
    expect(normalizeVisitPath(null)).toBeNull();
    expect(normalizeVisitPath(undefined)).toBeNull();
  });
});

describe('referrerHostFrom', () => {
  const own = ['www.solcomusic.online', 'solcomusic.vercel.app'];

  it('tiene solo l’host, minuscolo e senza porta', () => {
    expect(referrerHostFrom('https://www.google.com/search?q=solco+musica', own)).toBe(
      'www.google.com',
    );
    expect(referrerHostFrom('http://Example.COM:8080/pagina', own)).toBe('example.com');
    expect(referrerHostFrom('https://t.co/abc', own)).toBe('t.co');
  });

  it('scarta il sito stesso (anche senza www), gli schemi non web e il testo non URL', () => {
    expect(referrerHostFrom('https://www.solcomusic.online/search', own)).toBeNull();
    expect(referrerHostFrom('https://solcomusic.online/', own)).toBeNull();
    expect(referrerHostFrom('https://solcomusic.vercel.app/x', own)).toBeNull();
    expect(referrerHostFrom('android-app://com.google.android.gm/', own)).toBeNull();
    expect(referrerHostFrom('ftp://files.example.com/', own)).toBeNull();
    expect(referrerHostFrom('non un url', own)).toBeNull();
    expect(referrerHostFrom('', own)).toBeNull();
    expect(referrerHostFrom(undefined, own)).toBeNull();
  });
});

describe('deviceFrom, isAutomatedUserAgent, countryFrom', () => {
  it('riconosce telefono, tablet e computer', () => {
    expect(deviceFrom(IPHONE)).toBe('mobile');
    expect(deviceFrom(ANDROID_PHONE)).toBe('mobile');
    expect(deviceFrom(IPAD)).toBe('tablet');
    expect(deviceFrom(ANDROID_TABLET)).toBe('tablet');
    expect(deviceFrom(CHROME)).toBe('desktop');
    expect(deviceFrom(null)).toBe('desktop');
  });

  it('robot, strumenti e il monitor di Solco non sono visitatori', () => {
    for (const ua of [
      'SolcoMonitor/1.0 (+https://github.com/mr120712/mr120712)',
      `${CHROME} SolcoMonitor/1.0`,
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'curl/8.5.0',
      'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/130.0.0.0 Safari/537.36',
      'facebookexternalhit/1.1',
      'python-requests/2.32',
      '',
      null,
    ]) {
      expect(isAutomatedUserAgent(ua), String(ua)).toBe(true);
    }
    expect(isAutomatedUserAgent(CHROME)).toBe(false);
    expect(isAutomatedUserAgent(IPHONE)).toBe(false);
  });

  it('il Paese è un codice a due lettere maiuscolo o niente', () => {
    expect(countryFrom('it')).toBe('IT');
    expect(countryFrom(' DE ')).toBe('DE');
    expect(countryFrom('ITA')).toBeNull();
    expect(countryFrom('')).toBeNull();
    expect(countryFrom(null)).toBeNull();
  });
});

describe('impronta giornaliera del visitatore', () => {
  it('è stabile nel giorno, cambia il giorno dopo e con un altro IP o browser, e non contiene l’IP', () => {
    const today = visitorHashFor('2026-11-16', 'ip:203.0.113.7', CHROME);
    expect(today).toMatch(/^[0-9a-f]{24}$/);
    expect(visitorHashFor('2026-11-16', 'ip:203.0.113.7', CHROME)).toBe(today);
    expect(visitorHashFor('2026-11-17', 'ip:203.0.113.7', CHROME)).not.toBe(today);
    expect(visitorHashFor('2026-11-16', 'ip:203.0.113.8', CHROME)).not.toBe(today);
    expect(visitorHashFor('2026-11-16', 'ip:203.0.113.7', IPHONE)).not.toBe(today);
    expect(today).not.toContain('203.0.113.7');
    // Senza IP (hosting che non lo manda) l'impronta si calcola comunque.
    expect(visitorHashFor('2026-11-16', null, CHROME)).toMatch(/^[0-9a-f]{24}$/);
  });

  it('con un altro segreto del server le impronte sono diverse', () => {
    const first = visitorHashFor('2026-11-16', 'ip:203.0.113.7', CHROME);
    vi.stubEnv('BETTER_AUTH_SECRET', 'un-altro-segreto-0123456789abcdef0123456789');
    expect(visitorHashFor('2026-11-16', 'ip:203.0.113.7', CHROME)).not.toBe(first);
  });
});

describe('recordVisit', () => {
  function fakeDb() {
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'v1',
      ...args.data,
    }));
    const db = { siteVisit: { create, deleteMany: vi.fn() }, $queryRaw: vi.fn() };
    return { db: db as never, create };
  }

  it('salva giorno italiano, impronta, percorso normalizzato, host di provenienza, Paese e dispositivo: mai l’IP', async () => {
    const { db, create } = fakeDb();
    const headers = headersOf({
      'user-agent': IPHONE,
      'x-real-ip': '203.0.113.7',
      'x-vercel-ip-country': 'it',
      host: 'www.solcomusic.online',
    });
    const outcome = await recordVisit(
      { path: '/playlist/clx123/', referrer: 'https://www.google.com/', headers, now: NOW },
      db,
    );
    expect(outcome).toBe('recorded');
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data).toEqual({
      day: '2026-11-16',
      visitorHash: visitorHashFor('2026-11-16', 'ip:203.0.113.7', IPHONE),
      path: '/playlist/*',
      referrerHost: 'www.google.com',
      country: 'IT',
      device: 'mobile',
      createdAt: NOW,
    });
    expect(JSON.stringify(data)).not.toContain('203.0.113.7');
    expect(Object.keys(data)).not.toContain('ip');
    expect(Object.keys(data)).not.toContain('userAgent');
  });

  it('un visitatore che apre più pagine ha la stessa impronta; provenienza interna o assente → null', async () => {
    const { db, create } = fakeDb();
    const headers = headersOf({
      'user-agent': CHROME,
      'x-real-ip': '198.51.100.9',
      host: 'www.solcomusic.online',
    });
    await recordVisit(
      { path: '/', referrer: 'https://www.solcomusic.online/search', headers, now: NOW },
      db,
    );
    await recordVisit({ path: '/search', headers, now: NOW }, db);
    const [first, second] = create.mock.calls.map(
      (call) => call[0].data as Record<string, unknown>,
    );
    expect(first?.visitorHash).toBe(second?.visitorHash);
    expect(first?.referrerHost).toBeNull();
    expect(second?.referrerHost).toBeNull();
    expect(first?.country).toBeNull();
    expect(second?.device).toBe('desktop');
  });

  it('ignora robot e monitor, browser con Do Not Track o Global Privacy Control, percorsi non conteggiabili', async () => {
    const { db, create } = fakeDb();
    const base = { 'x-real-ip': '203.0.113.7', host: 'www.solcomusic.online' };
    expect(
      await recordVisit(
        { path: '/', headers: headersOf({ ...base, 'user-agent': 'SolcoMonitor/1.0' }), now: NOW },
        db,
      ),
    ).toBe('ignored');
    expect(
      await recordVisit(
        { path: '/', headers: headersOf({ ...base, 'user-agent': CHROME, dnt: '1' }), now: NOW },
        db,
      ),
    ).toBe('ignored');
    expect(
      await recordVisit(
        {
          path: '/',
          headers: headersOf({ ...base, 'user-agent': CHROME, 'sec-gpc': '1' }),
          now: NOW,
        },
        db,
      ),
    ).toBe('ignored');
    expect(
      await recordVisit(
        {
          path: '/admin/visitatori',
          headers: headersOf({ ...base, 'user-agent': CHROME }),
          now: NOW,
        },
        db,
      ),
    ).toBe('ignored');
    expect(
      await recordVisit(
        { path: '/search?q=x', headers: headersOf({ ...base, 'user-agent': CHROME }), now: NOW },
        db,
      ),
    ).toBe('ignored');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('buildVisitorStats e getVisitorStats', () => {
  const keys = visitorDayKeys(NOW);

  it('i giorni del grafico sono 30 in ora italiana, dal più vecchio a oggi', () => {
    expect(keys).toHaveLength(30);
    expect(keys.at(-1)).toBe(romeDayKey(NOW));
    expect(keys[0]).toBe('2026-10-18');
    expect(keys.at(-1)).toBe('2026-11-16');
  });

  /** Una riga grezza con colonne in più, come potrebbe restituirle una query cambiata per sbaglio. */
  const withExtra = <Row>(row: Row, extra: Record<string, unknown>): Row =>
    ({ ...row, ...extra }) as Row;

  it('riempie con zero, converte i bigint, somma le finestre e lascia fuori le colonne in più', () => {
    const stats = buildVisitorStats(NOW, keys, {
      daily: [
        withExtra({ day: '2026-11-16', visitors: 3n, views: 7n }, { visitorHash: 'mai' }),
        { day: '2026-11-10', visitors: 2n, views: 2n },
        { day: '2026-10-18', visitors: 1n, views: 1n },
        // Fuori finestra: ignorato.
        { day: '2026-09-01', visitors: 9n, views: 9n },
      ],
      pages: [withExtra({ path: '/', visitors: 4n, views: 9n }, { ip: '203.0.113.7' })],
      countries: [
        { country: 'IT', visitors: 5n },
        { country: null, visitors: 1n },
      ],
      referrers: [{ host: 'www.google.com', visitors: 2n }],
      devices: [
        { device: 'mobile', visitors: 4n },
        { device: 'smartwatch', visitors: 1n },
      ],
    });
    expect(AdminVisitorsSchema.parse(stats)).toEqual(stats);
    expect(stats.today).toEqual({ visitors: 3, views: 7 });
    expect(stats.last7d).toEqual({ visitors: 5, views: 9 });
    expect(stats.last30d).toEqual({ visitors: 6, views: 10 });
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily[0]).toEqual({ day: '2026-10-18', visitors: 1, views: 1 });
    expect(stats.daily.filter((day) => day.visitors === 0)).toHaveLength(27);
    expect(stats.pages).toEqual([{ path: '/', visitors: 4, views: 9 }]);
    expect(stats.countries).toEqual([
      { country: 'IT', visitors: 5 },
      { country: '', visitors: 1 },
    ]);
    expect(stats.devices).toEqual([{ device: 'mobile', visitors: 4 }]);
    expect(stats.retentionDays).toBe(VISITORS_RETENTION_DAYS);
    expect(JSON.stringify(stats)).not.toContain('203.0.113.7');
    expect(JSON.stringify(stats)).not.toContain('visitorHash');
  });

  it('rifiuta giorni o conteggi non validi', () => {
    expect(() =>
      buildVisitorStats(NOW, keys, {
        daily: [{ day: 'ieri', visitors: 1n, views: 1n }],
        pages: [],
        countries: [],
        referrers: [],
        devices: [],
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildVisitorStats(NOW, keys, {
        daily: [],
        pages: [{ path: '/', visitors: -1, views: 1n }],
        countries: [],
        referrers: [],
        devices: [],
      }),
    ).toThrow(TypeError);
  });

  it('getVisitorStats interroga la tabella per giorno con query parametrizzate e compone il contratto', async () => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      queries.push(text);
      params.push(values);
      if (text.includes('"referrerHost" AS "host"'))
        return [{ host: 'www.google.com', visitors: 2n }];
      if (text.includes('"device"')) return [{ device: 'desktop', visitors: 3n }];
      if (text.includes('"country"')) return [{ country: 'IT', visitors: 3n }];
      if (text.includes('"path"')) return [{ path: '/', visitors: 3n, views: 5n }];
      return [{ day: '2026-11-16', visitors: 3n, views: 5n }];
    });
    const stats = await getVisitorStats(NOW, { $queryRaw: queryRaw, siteVisit: {} } as never);
    expect(AdminVisitorsSchema.parse(stats)).toEqual(stats);
    expect(stats.today).toEqual({ visitors: 3, views: 5 });
    expect(stats.pages).toEqual([{ path: '/', visitors: 3, views: 5 }]);
    expect(stats.referrers).toEqual([{ host: 'www.google.com', visitors: 2 }]);
    expect(queries).toHaveLength(5);
    for (const text of queries) {
      expect(text).toContain('FROM "SiteVisit"');
      expect(text).toContain('COUNT(DISTINCT "visitorHash")');
    }
    // Il primo giorno della finestra entra come parametro, mai concatenato nel testo.
    for (const values of params) expect(values[0]).toBe('2026-10-18');
    expect(queries.join('\n')).not.toContain('2026-10-18');
  });

  it('pruneOldVisits cancella solo le righe oltre 90 giorni', async () => {
    const deleteMany = vi.fn(async () => ({ count: 4 }));
    const result = await pruneOldVisits(NOW, {
      $queryRaw: vi.fn(),
      siteVisit: { deleteMany },
    } as never);
    expect(result).toEqual({ count: 4 });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: visitRetentionCutoff(NOW) } },
    });
    expect(NOW.getTime() - visitRetentionCutoff(NOW).getTime()).toBe(90 * 86_400_000);
  });
});
