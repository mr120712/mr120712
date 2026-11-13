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

  it('usa la Accelerate con prefisso dell’integrazione quando PRISMA_DATABASE_URL non è impostata', () => {
    const env = { VERCEL: '1', DATABASE_URL: direct, MY_SOLCO_PRISMA_DATABASE_URL: pooled };
    expect(preferPooledDatabaseUrl(env)).toBe(true);
    expect(env.DATABASE_URL).toBe(pooled);
  });

  it('usa il pooled con prefisso dell’integrazione se non c’è nessuna Accelerate', () => {
    const env = {
      VERCEL: '1',
      DATABASE_URL: direct,
      MY_SOLCO_DATABASE_URL_POOLED:
        'postgres://u:p@pooled.example.test:5432/postgres?sslmode=require',
    };
    expect(preferPooledDatabaseUrl(env)).toBe(true);
    expect(env.DATABASE_URL).toBe(
      'postgres://u:p@pooled.example.test:5432/postgres?sslmode=require&pgbouncer=true',
    );
  });

  it('il nome esatto ha priorità sulla variante con prefisso', () => {
    const exact = 'prisma+postgres://accelerate.example.test/?api_key=EXACT';
    const env = {
      VERCEL: '1',
      DATABASE_URL: direct,
      PRISMA_DATABASE_URL: exact,
      MY_SOLCO_PRISMA_DATABASE_URL: 'prisma+postgres://accelerate.example.test/?api_key=PREFIXED',
    };
    expect(preferPooledDatabaseUrl(env)).toBe(true);
    expect(env.DATABASE_URL).toBe(exact);
  });

  it('ignora una variante con prefisso che non è una URL valida (nessuna sostituzione)', () => {
    const env = {
      VERCEL: '1',
      DATABASE_URL: direct,
      MY_SOLCO_PRISMA_DATABASE_URL: 'non-una-url',
      MY_SOLCO_DATABASE_URL: direct, // il diretto (suffisso diverso) non deve essere usato come pooled
    };
    expect(preferPooledDatabaseUrl(env)).toBe(false);
    expect(env.DATABASE_URL).toBe(direct);
  });
});
