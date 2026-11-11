// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import { preferPooledDatabaseUrl } from '@/lib/runtime-database-url';

const direct = 'postgres://u:p@db.example.test:5432/postgres';
const pooled = 'prisma+postgres://accelerate.example.test/?api_key=k';

describe('URL del database a runtime', () => {
  it('usa il pool Accelerate su Vercel', () => {
    const env = { VERCEL: '1', DATABASE_URL: direct, PRISMA_DATABASE_URL: pooled };
    expect(preferPooledDatabaseUrl(env)).toBe(true);
    expect(env.DATABASE_URL).toBe(pooled);
  });

  it('usa l’endpoint pooled con pgbouncer=true', () => {
    const env = {
      VERCEL: '1',
      DATABASE_URL: direct,
      PRISMA_DATABASE_URL: direct,
      DATABASE_URL_POOLED: 'postgres://u:p@pooled.example.test:5432/postgres?sslmode=require',
    };
    expect(preferPooledDatabaseUrl(env)).toBe(true);
    expect(env.DATABASE_URL).toBe(
      'postgres://u:p@pooled.example.test:5432/postgres?sslmode=require&pgbouncer=true',
    );
  });

  it('non cambia nulla fuori da Vercel, se disattivato o senza URL Accelerate', () => {
    for (const env of [
      { DATABASE_URL: direct, PRISMA_DATABASE_URL: pooled },
      { VERCEL: '1', SOLCO_DB_DIRECT: '1', DATABASE_URL: direct, PRISMA_DATABASE_URL: pooled },
      { VERCEL: '1', DATABASE_URL: direct, PRISMA_DATABASE_URL: direct },
      { VERCEL: '1', DATABASE_URL: direct },
    ]) {
      expect(preferPooledDatabaseUrl(env)).toBe(false);
      expect(env.DATABASE_URL).toBe(direct);
    }
  });
});
