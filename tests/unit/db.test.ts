// @vitest-environment node
import { describe, expect, test, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { MAX_IDLE_CONNECTION_LIFETIME_SECONDS, withIdleConnectionLimit } = await import(
  // biome-ignore lint/style/noRestrictedImports: a node-environment unit test of the server singleton.
  '@/lib/db'
);

const limit = `max_idle_connection_lifetime=${MAX_IDLE_CONNECTION_LIFETIME_SECONDS}`;

describe('withIdleConnectionLimit', () => {
  test('stays below the 10 s sandbox freeze delay', () => {
    expect(MAX_IDLE_CONNECTION_LIFETIME_SECONDS).toBeLessThan(10);
  });

  test('adds the limit to a URL without a query string', () => {
    expect(withIdleConnectionLimit('REDACTED/db')).toBe(
      `REDACTED/db?${limit}`,
    );
  });

  test('appends the limit after existing parameters', () => {
    expect(withIdleConnectionLimit('REDACTED/db?sslmode=require&pgbouncer=true')).toBe(
      `REDACTED/db?sslmode=require&pgbouncer=true&${limit}`,
    );
    expect(withIdleConnectionLimit('REDACTED/db?sslmode=require&')).toBe(
      `REDACTED/db?sslmode=require&${limit}`,
    );
  });

  test('keeps the encoded credentials as they are', () => {
    expect(withIdleConnectionLimit('REDACTED/db')).toBe(
      `REDACTED/db?${limit}`,
    );
  });

  test('keeps a value the app already set', () => {
    const url = 'REDACTED/db?MAX_IDLE_CONNECTION_LIFETIME=60';
    expect(withIdleConnectionLimit(url)).toBe(url);
  });

  test('leaves other URLs unchanged', () => {
    expect(withIdleConnectionLimit(undefined)).toBeUndefined();
    expect(withIdleConnectionLimit('')).toBe('');
    expect(withIdleConnectionLimit('prisma+postgres://accelerate.prisma-data.net/?api_key=k')).toBe(
      'prisma+postgres://accelerate.prisma-data.net/?api_key=k',
    );
    expect(withIdleConnectionLimit('REDACTED/db#x')).toBe(
      'REDACTED/db#x',
    );
  });
});
