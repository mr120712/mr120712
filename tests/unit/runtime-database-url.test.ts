// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import { preferPooledDatabaseUrl } from '@/lib/runtime-database-url';

const direct = 'postgres://u:p@db.example.test:5432/postgres';
const accelerate = 'prisma+postgres://accelerate.example.test/?api_key=k';
const neonPooled =
  'postgres://u:p@ep-cool-name-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';

describe('URL del database a runtime', () => {
  it('usa il pool Accelerate (PRISMA_DATABASE_URL) su Vercel', () => {
    const env = { VERCEL: '1', DATABASE_URL: direct, PRISMA_DATABASE_URL: accelerate };
    expect(preferPooledDatabaseUrl(env)).toBe(true);
    expect(env.DATABASE_URL).toBe(accelerate);
  });

  it('usa DATABASE_URL_POOLED aggiungendo pgbouncer=true', () => {
    const env = {
      VERCEL: '1',
      DATABASE_URL: direct,
      DATABASE_URL_POOLED: 'postgres://u:p@pooled.example.test:5432/postgres?sslmode=require',
    };
    expect(preferPooledDatabaseUrl(env)).toBe(true);
    expect(env.DATABASE_URL).toBe(
      'postgres://u:p@pooled.example.test:5432/postgres?sslmode=require&pgbouncer=true',
    );
  });

  it('Neon: DATABASE_URL su host "-pooler" riceve pgbouncer=true', () => {
    const env = { VERCEL: '1', DATABASE_URL: neonPooled };
    expect(preferPooledDatabaseUrl(env)).toBe(true);
    expect(env.DATABASE_URL).toBe(`${neonPooled}&pgbouncer=true`);
  });

  it('Supabase: host "pooler." riceve pgbouncer=true', () => {
    const supa = 'postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';
    const env = { VERCEL: '1', DATABASE_URL: supa };
    expect(preferPooledDatabaseUrl(env)).toBe(true);
    expect(env.DATABASE_URL).toBe(`${supa}?pgbouncer=true`);
  });

  it('non tocca una DATABASE_URL pooler che ha già pgbouncer', () => {
    const already = `${neonPooled}&pgbouncer=true`;
    const env = { VERCEL: '1', DATABASE_URL: already };
    expect(preferPooledDatabaseUrl(env)).toBe(false);
    expect(env.DATABASE_URL).toBe(already);
  });

  it('non cambia nulla: fuori Vercel, disattivato, o DATABASE_URL diretto (non-pooler)', () => {
    for (const env of [
      { DATABASE_URL: direct, PRISMA_DATABASE_URL: accelerate },
      { VERCEL: '1', SOLCO_DB_DIRECT: '1', DATABASE_URL: direct, PRISMA_DATABASE_URL: accelerate },
      { VERCEL: '1', DATABASE_URL: direct, PRISMA_DATABASE_URL: direct },
      { VERCEL: '1', DATABASE_URL: direct },
    ]) {
      expect(preferPooledDatabaseUrl(env)).toBe(false);
      expect(env.DATABASE_URL).toBe(direct);
    }
  });

  it('NON si fa dirottare da variabili di integrazioni vecchie (MY_SOLCO_*): vince la Neon', () => {
    // Residui di un provider precedente: non devono sostituire la DATABASE_URL attiva di Neon.
    const env = {
      VERCEL: '1',
      DATABASE_URL: neonPooled,
      MY_SOLCO_PRISMA_DATABASE_URL: 'prisma+postgres://accelerate.old-dead.test/?api_key=OLD',
      MY_SOLCO_DATABASE_URL_POOLED: 'postgres://u:p@old-dead.test:5432/postgres',
      MY_SOLCO_DATABASE_URL: direct,
    };
    expect(preferPooledDatabaseUrl(env)).toBe(true);
    expect(env.DATABASE_URL).toBe(`${neonPooled}&pgbouncer=true`);
  });
});
