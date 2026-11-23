// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { _resetArtexAuth, artexConfig, artexStatus } from '@/lib/business/artex-client.server';

const URL_OK = 'https://5-222-15-32.sslip.io';
const PASS = 'a-strong-pass-123';

function jsonRes(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
}

describe('artexConfig', () => {
  it('requires url + password', () => {
    expect(artexConfig({})).toBeNull();
    expect(artexConfig({ ARTEX_URL: URL_OK })).toBeNull();
    expect(artexConfig({ ARTEX_PASSWORD: PASS })).toBeNull();
  });
  it('refuses a malformed URL or a short password', () => {
    expect(artexConfig({ ARTEX_URL: 'file:///etc', ARTEX_PASSWORD: PASS })).toBeNull();
    expect(artexConfig({ ARTEX_URL: URL_OK, ARTEX_PASSWORD: 'short' })).toBeNull();
  });
  it('trims and strips trailing slashes', () => {
    const c = artexConfig({
      ARTEX_URL: `${URL_OK}///   `.replace(/\s/g, ''),
      ARTEX_PASSWORD: PASS,
    });
    expect(c?.url).toBe(URL_OK);
    expect(c?.username).toBe('ARTEX');
  });
});

describe('artexStatus', () => {
  beforeEach(() => _resetArtexAuth());
  afterEach(() => vi.restoreAllMocks());

  it('returns not_configured without env', async () => {
    expect((await artexStatus({})).status).toBe('not_configured');
  });

  it('logs in, calls /api/stats + findings, returns a snapshot', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/auth/login')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ username: 'ARTEX', password: PASS });
        return jsonRes({ token: 'a'.repeat(32) });
      }
      if (u.endsWith('/api/stats')) {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          `Bearer ${'a'.repeat(32)}`,
        );
        return jsonRes({
          tasks: { total: 3, running: 1 },
          tokens: { today: 4200 },
        });
      }
      if (u.endsWith('/api/exploration/findings/stats')) {
        return jsonRes({ findings: { total: 5, by_severity: { high: 2, medium: 3 } } });
      }
      throw new Error(`unexpected ${u}`);
    });
    const outcome = await artexStatus(
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
    );
    if (outcome.status !== 'ok') throw new Error(`bad: ${JSON.stringify(outcome)}`);
    expect(outcome.data).toEqual({
      tasks: { total: 3, running: 1 },
      findings: { total: 5, bySeverity: { high: 2, medium: 3 } },
      tokensToday: 4200,
    });
    // Login happens once per process.
    const loginCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/auth/login'));
    expect(loginCalls).toHaveLength(1);
  });

  it('401 on a request re-logs in and retries once', async () => {
    let seenAuth = 0;
    let seenStats = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/auth/login')) {
        seenAuth++;
        return jsonRes({ token: `t${seenAuth}`.padEnd(32, 'x') });
      }
      if (u.endsWith('/api/stats')) {
        seenStats++;
        if (seenStats === 1) return jsonRes({}, { status: 401 });
        return jsonRes({ tasks: { total: 0, running: 0 } });
      }
      if (u.endsWith('/api/exploration/findings/stats')) {
        return jsonRes({ findings: { total: 0, by_severity: {} } });
      }
      throw new Error(`unexpected ${u}`);
    });
    const outcome = await artexStatus(
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
    );
    expect(outcome.status).toBe('ok');
    expect(seenAuth).toBe(2); // first login + re-login after 401
    expect(seenStats).toBe(2);
  });

  it('a wrong password surfaces as unauthorized', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/auth/login'))
        return jsonRes({ error: 'nope' }, { status: 401 });
      throw new Error('login should have failed before reaching here');
    });
    const outcome = await artexStatus(
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toBe('unauthorized');
  });

  it('network failure surfaces as unreachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('ECONNREFUSED');
    });
    const outcome = await artexStatus(
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toBe('unreachable');
  });

  it('findings endpoint failing does not kill the whole status', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/auth/login')) return jsonRes({ token: 'x'.repeat(32) });
      if (u.endsWith('/api/stats')) {
        return jsonRes({
          tasks: { total: 1, running: 0 },
          findings: { total: 2, by_severity: { high: 2 } },
        });
      }
      if (u.endsWith('/api/exploration/findings/stats')) {
        return jsonRes({}, { status: 500 });
      }
      throw new Error(`unexpected ${u}`);
    });
    const outcome = await artexStatus(
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
    );
    if (outcome.status !== 'ok') throw new Error(`bad: ${JSON.stringify(outcome)}`);
    // Falls back to /api/stats's own findings block.
    expect(outcome.data.findings).toEqual({ total: 2, bySeverity: { high: 2 } });
  });
});
