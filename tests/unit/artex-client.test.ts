// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  _resetArtexAuth,
  artexConfig,
  artexStatus,
  askArtex,
} from '@/lib/business/artex-client.server';

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

describe('askArtex', () => {
  beforeEach(() => _resetArtexAuth());
  afterEach(() => vi.restoreAllMocks());

  function script(steps: {
    convId?: number;
    pages: Array<{ items?: Array<Record<string, unknown>>; cursor: number; running: boolean }>;
  }) {
    const convId = steps.convId ?? 42;
    let pageIndex = 0;
    const calls: Array<{ url: string; method?: string }> = [];
    return {
      calls,
      convId,
      fetchMock: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, method: init?.method });
        if (u.endsWith('/api/auth/login')) return jsonRes({ token: 't'.repeat(32) });
        if (u.endsWith('/api/conversations')) return jsonRes({ id: convId, agent_key: 'auto' });
        if (u.endsWith(`/api/conversations/${convId}/messages`) && init?.method === 'POST') {
          return jsonRes({ ok: true });
        }
        if (u.includes(`/api/conversations/${convId}/messages?since=`)) {
          const page = steps.pages[pageIndex] ?? steps.pages[steps.pages.length - 1];
          pageIndex++;
          return jsonRes({ items: [], cursor: 0, running: false, ...page });
        }
        throw new Error(`unexpected ${u}`);
      }),
    };
  }

  it('creates a conversation, posts the message, returns the final assistant text', async () => {
    const { fetchMock } = script({
      pages: [
        {
          items: [
            { seq: 1, worker: 'user', kind: 'text', summary: 'the question', detail: '' },
            { seq: 2, worker: 'auto', kind: 'text', summary: 'partial…', detail: '' },
          ],
          cursor: 2,
          running: true,
        },
        {
          items: [
            {
              seq: 3,
              worker: 'auto',
              kind: 'result',
              summary: 'Final answer',
              detail: 'Final answer with details.',
            },
          ],
          cursor: 3,
          running: false,
        },
      ],
    });
    const outcome = await askArtex(
      'What is open?',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
      { pollIntervalMs: 1, timeoutMs: 5_000 },
    );
    if (outcome.status !== 'ok') throw new Error(`bad: ${JSON.stringify(outcome)}`);
    expect(outcome.reply).toBe('Final answer with details.');
    expect(outcome.conversationId).toBe(42);
    // It asked for the conversation to be created once, with agent_key.
    const create = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/conversations'));
    expect(create).toBeDefined();
    const body = JSON.parse(String(create?.[1]?.body));
    expect(body.agent_key).toBe('auto');
  });

  it('prefers a `result` row even after a later plain `text`', async () => {
    const { fetchMock } = script({
      pages: [
        {
          items: [
            { seq: 1, worker: 'auto', kind: 'result', summary: 'THE answer', detail: '' },
            { seq: 2, worker: 'auto', kind: 'text', summary: 'trailing chatter', detail: '' },
          ],
          cursor: 2,
          running: false,
        },
      ],
    });
    const outcome = await askArtex(
      'q',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
      { pollIntervalMs: 1, timeoutMs: 2_000 },
    );
    if (outcome.status !== 'ok') throw new Error(`bad: ${JSON.stringify(outcome)}`);
    expect(outcome.reply).toBe('THE answer');
  });

  it('times out as still_running when the agent never finishes', async () => {
    const { fetchMock } = script({
      pages: [
        { items: [], cursor: 0, running: true },
        { items: [], cursor: 0, running: true },
        { items: [], cursor: 0, running: true },
      ],
    });
    const outcome = await askArtex(
      'q',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
      { pollIntervalMs: 10, timeoutMs: 100 },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toBe('still_running');
  });

  it('finished conversation with no assistant text surfaces empty_reply', async () => {
    const { fetchMock } = script({
      pages: [
        {
          items: [{ seq: 1, worker: 'user', kind: 'text', summary: 'q', detail: '' }],
          cursor: 1,
          running: false,
        },
      ],
    });
    const outcome = await askArtex(
      'q',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
      { pollIntervalMs: 1, timeoutMs: 2_000 },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toBe('empty_reply');
  });

  it('empty question never reaches ARTEX', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('should not reach fetch');
    });
    const outcome = await askArtex(
      '   ',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toBe('empty_question');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('not_configured when ARTEX_URL / ARTEX_PASSWORD are missing', async () => {
    const outcome = await askArtex('anything', {});
    expect(outcome.status).toBe('not_configured');
  });

  it('network failure surfaces as unreachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('ECONNREFUSED');
    });
    const outcome = await askArtex(
      'q',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
      { pollIntervalMs: 1, timeoutMs: 1_000 },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toBe('unreachable');
  });

  it('conversationId option skips POST /api/conversations and reuses the id', async () => {
    const { fetchMock } = script({
      convId: 77,
      pages: [
        {
          items: [{ seq: 1, worker: 'auto', kind: 'result', summary: 'answer', detail: '' }],
          cursor: 1,
          running: false,
        },
      ],
    });
    const outcome = await askArtex(
      'follow-up',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
      { pollIntervalMs: 1, timeoutMs: 5_000, conversationId: 77 },
    );
    if (outcome.status !== 'ok') throw new Error(`bad: ${JSON.stringify(outcome)}`);
    expect(outcome.conversationId).toBe(77);
    // Crucially: no POST to /api/conversations.
    const create = fetchMock.mock.calls.find(
      ([u, init]) =>
        String(u).endsWith('/api/conversations') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(create).toBeUndefined();
  });

  it('onProgress is called with the latest assistant text as polling advances', async () => {
    const { fetchMock } = script({
      pages: [
        {
          items: [{ seq: 1, worker: 'auto', kind: 'text', summary: 'partial 1', detail: '' }],
          cursor: 1,
          running: true,
        },
        {
          items: [{ seq: 2, worker: 'auto', kind: 'text', summary: 'partial 2', detail: '' }],
          cursor: 2,
          running: true,
        },
        {
          items: [{ seq: 3, worker: 'auto', kind: 'result', summary: 'final', detail: '' }],
          cursor: 3,
          running: false,
        },
      ],
    });
    const calls: Array<{ text: string; running: boolean }> = [];
    const outcome = await askArtex(
      'q',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
      {
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        onProgress: (text, running) => {
          calls.push({ text, running });
        },
      },
    );
    if (outcome.status !== 'ok') throw new Error(`bad: ${JSON.stringify(outcome)}`);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[calls.length - 1]).toEqual({ text: 'final', running: false });
    expect(calls.some((c) => c.text === 'partial 1')).toBe(true);
  });

  it('onProgress errors do not break the chat', async () => {
    const { fetchMock } = script({
      pages: [
        {
          items: [{ seq: 1, worker: 'auto', kind: 'result', summary: 'pong', detail: '' }],
          cursor: 1,
          running: false,
        },
      ],
    });
    const outcome = await askArtex(
      'q',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
      {
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        onProgress: () => {
          throw new Error('boom');
        },
      },
    );
    if (outcome.status !== 'ok') throw new Error(`bad: ${JSON.stringify(outcome)}`);
    expect(outcome.reply).toBe('pong');
  });

  it('still_running and empty_reply carry the conversationId so Telegram can thread', async () => {
    // still_running: never reaches running=false (we use a very small timeoutMs so the loop exits first)
    const stillFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/auth/login')) return jsonRes({ token: 't'.repeat(32) });
      if (u.endsWith('/api/conversations')) return jsonRes({ id: 500, agent_key: 'auto' });
      if (u.endsWith('/api/conversations/500/messages') && init?.method === 'POST') {
        return jsonRes({ ok: true });
      }
      if (u.includes('/api/conversations/500/messages?since='))
        return jsonRes({ items: [], cursor: 0, running: true });
      throw new Error(`unexpected ${u}`);
    });
    const stillOutcome = await askArtex(
      'q',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      stillFetch as unknown as typeof fetch,
      { pollIntervalMs: 1, timeoutMs: 50 },
    );
    expect(stillOutcome.status).toBe('failed');
    if (stillOutcome.status === 'failed') {
      expect(stillOutcome.error).toBe('still_running');
      expect(stillOutcome.conversationId).toBe(500);
    }
  });
});

describe('artexPauseTask', () => {
  beforeEach(() => _resetArtexAuth());
  afterEach(() => vi.restoreAllMocks());

  it('POSTs {action:"pause"} to /api/tasks/{id}/control and returns ok', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/auth/login')) return jsonRes({ token: 't'.repeat(32) });
      if (u.endsWith('/api/tasks/7/control')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ action: 'pause' });
        return jsonRes({ ok: true });
      }
      throw new Error(`unexpected ${u}`);
    });
    const { artexPauseTask } = await import('@/lib/business/artex-client.server');
    const out = await artexPauseTask(
      7,
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
    );
    expect(out).toEqual({ status: 'ok' });
  });

  it('bad id (not digits) is rejected without calling the server', async () => {
    const fetchMock = vi.fn(async () => jsonRes({}));
    const { artexPauseTask } = await import('@/lib/business/artex-client.server');
    const out = await artexPauseTask(
      'abc',
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
    );
    expect(out).toEqual({ status: 'failed', error: 'bad_id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('http_404 maps to not_found', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/auth/login')) return jsonRes({ token: 't'.repeat(32) });
      return new Response('nope', { status: 404 });
    });
    const { artexPauseTask } = await import('@/lib/business/artex-client.server');
    const out = await artexPauseTask(
      99,
      { ARTEX_URL: URL_OK, ARTEX_PASSWORD: PASS },
      fetchMock as unknown as typeof fetch,
    );
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.error).toBe('not_found');
  });

  it('not configured returns a clean sentinel', async () => {
    const { artexPauseTask } = await import('@/lib/business/artex-client.server');
    const out = await artexPauseTask(1, {}, vi.fn() as unknown as typeof fetch);
    expect(out).toEqual({ status: 'not_configured' });
  });
});
