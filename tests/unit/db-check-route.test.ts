// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock('@/lib/runtime-database-url', () => ({
  describeDatabaseUrls: () => 'vercel=1 DATABASE_URL=postgres://db.prisma.io',
}));

import { GET } from '@/app/api/db-check/route';

const SECRET = 'cron-secret-test';
const ORIGINAL = process.env.CRON_SECRET;

function req(bearer?: string) {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return new Request('https://solco.example/api/db-check', { headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = SECRET;
  mocks.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('GET /api/db-check', () => {
  it('404 senza Authorization o con secret sbagliato', async () => {
    expect((await GET(req())).status).toBe(404);
    expect((await GET(req('sbagliato'))).status).toBe(404);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('404 anche se CRON_SECRET non è configurato', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req(SECRET))).status).toBe(404);
  });

  it('200 ok:true quando la query riesce', async () => {
    const res = await GET(req(SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.urls).toContain('db.prisma.io');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('503 ok:false con il codice Prisma esatto quando la connessione fallisce', async () => {
    const err = Object.assign(new Error('Can’t reach database server at `db.prisma.io:5432`'), {
      code: 'P1001',
      name: 'PrismaClientInitializationError',
    });
    mocks.queryRaw.mockRejectedValue(err);
    const res = await GET(req(SECRET));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('P1001');
    expect(body.error.name).toBe('PrismaClientInitializationError');
  });

  it('redige eventuali credenziali nel messaggio di errore', async () => {
    mocks.queryRaw.mockRejectedValue(
      new Error('connect failed for postgres://utente:segreto@host:5432/db'),
    );
    const res = await GET(req(SECRET));
    const body = await res.json();
    expect(body.error.message).not.toContain('segreto');
    expect(body.error.message).toContain('•••');
  });
});
