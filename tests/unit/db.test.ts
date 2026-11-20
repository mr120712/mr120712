// @vitest-environment node
import { describe, expect, test, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { MAX_IDLE_CONNECTION_LIFETIME_SECONDS, withIdleConnectionLimit } = await import(
  // biome-ignore lint/style/noRestrictedImports: a node-environment unit test of the server singleton.
  '@/lib/db'
);

const limit = `max_idle_connection_lifetime=${MAX_IDLE_CONNECTION_LIFETIME_SECONDS}`;
// URL Postgres validi: withIdleConnectionLimit riscrive solo gli URL postgres(ql)://.
const PG = 'postgresql://user:pass@host:5432';
const PG_ENCODED = 'postgresql://user:p%40ss%3Aword@host:5432'; // credenziali con codifica %-

describe('withIdleConnectionLimit', () => {
  test('stays below the 10 s sandbox freeze delay', () => {
    expect(MAX_IDLE_CONNECTION_LIFETIME_SECONDS).toBeLessThan(10);
  });

  test('adds the limit to a URL without a query string', () => {
    expect(withIdleConnectionLimit(`${PG}/db`)).toBe(`${PG}/db?${limit}`);
  });

  test('appends the limit after existing parameters', () => {
    expect(withIdleConnectionLimit(`${PG}/db?sslmode=require&pgbouncer=true`)).toBe(
      `${PG}/db?sslmode=require&pgbouncer=true&${limit}`,
    );
    expect(withIdleConnectionLimit(`${PG}/db?sslmode=require&`)).toBe(
      `${PG}/db?sslmode=require&${limit}`,
    );
  });

  test('keeps the encoded credentials as they are', () => {
    expect(withIdleConnectionLimit(`${PG_ENCODED}/db`)).toBe(`${PG_ENCODED}/db?${limit}`);
  });

  test('keeps a value the app already set', () => {
    const url = `${PG}/db?MAX_IDLE_CONNECTION_LIFETIME=60`;
    expect(withIdleConnectionLimit(url)).toBe(url);
  });

  test('leaves other URLs unchanged', () => {
    expect(withIdleConnectionLimit(undefined)).toBeUndefined();
    expect(withIdleConnectionLimit('')).toBe('');
    expect(withIdleConnectionLimit('prisma+postgres://accelerate.prisma-data.net/?api_key=k')).toBe(
      'prisma+postgres://accelerate.prisma-data.net/?api_key=k',
    );
    expect(withIdleConnectionLimit(`${PG}/db#x`)).toBe(`${PG}/db#x`);
  });
});
