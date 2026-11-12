import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CookieJar } from '../src/cookies.js';
import { SolcoApiError } from '../src/errors.js';
import type { FetchLike } from '../src/http.js';
import { HttpClient } from '../src/http.js';

interface Captured {
  url: string;
  init: RequestInit;
}

function recorder(response: () => Response): {
  fetch: FetchLike;
  calls: Captured[];
  at: (index: number) => Captured;
} {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return response();
  };
  const at = (index: number): Captured => {
    const call = calls[index];
    if (!call) throw new Error(`nessuna chiamata registrata all'indice ${index}`);
    return call;
  };
  return { fetch: fetchImpl, calls, at };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('GET costruisce URL con query, saltando undefined/null', async () => {
  const rec = recorder(() => json({ ok: true }));
  const http = new HttpClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  await http.requestJson('/api/music/radio', { query: { q: 'jazz', tag: undefined, limit: 10 } });
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.at(0).url, 'https://example.test/api/music/radio?q=jazz&limit=10');
});

test('baseUrl con slash finale viene normalizzato', async () => {
  const rec = recorder(() => json({}));
  const http = new HttpClient({ baseUrl: 'https://example.test/', fetch: rec.fetch });
  await http.requestJson('/health');
  assert.equal(rec.at(0).url, 'https://example.test/health');
});

test('una mutazione lato server invia Origin = baseUrl e il cookie di sessione', async () => {
  const rec = recorder(() => json({ allowed: true }));
  const jar = new CookieJar({ session: 'abc' });
  const http = new HttpClient({
    baseUrl: 'https://example.test',
    fetch: rec.fetch,
    cookieJar: jar,
  });
  await http.requestJson('/api/music/plays', { method: 'POST', body: { qualifiedId: 'audius:1' } });
  const headers = rec.at(0).init.headers as Headers;
  assert.equal(headers.get('origin'), 'https://example.test');
  assert.equal(headers.get('cookie'), 'session=abc');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(rec.at(0).init.body, JSON.stringify({ qualifiedId: 'audius:1' }));
});

test('una GET non invia Origin', async () => {
  const rec = recorder(() => json({}));
  const http = new HttpClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  await http.requestJson('/api/music/home');
  const headers = rec.at(0).init.headers as Headers;
  assert.equal(headers.get('origin'), null);
});

test('origin personalizzato ha la precedenza sul baseUrl', async () => {
  const rec = recorder(() => json({}));
  const http = new HttpClient({
    baseUrl: 'https://example.test',
    origin: 'https://app.solco.test',
    fetch: rec.fetch,
  });
  await http.requestJson('/api/music/plays', { method: 'POST', body: {} });
  const headers = rec.at(0).init.headers as Headers;
  assert.equal(headers.get('origin'), 'https://app.solco.test');
});

test('uno stato non-2xx lancia SolcoApiError con codice e flag', async () => {
  const rec = recorder(() => json({ error: 'forbidden_origin', message: 'no' }, 403));
  const http = new HttpClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  await assert.rejects(
    () => http.requestJson('/api/music/plays', { method: 'POST', body: {} }),
    (err: unknown) => {
      assert.ok(err instanceof SolcoApiError);
      assert.equal(err.status, 403);
      assert.equal(err.code, 'forbidden_origin');
      assert.equal(err.isForbiddenOrigin, true);
      assert.equal(err.message, 'no');
      return true;
    },
  );
});

test('429 porta retryAfterSeconds dal corpo', async () => {
  const rec = recorder(() =>
    json({ error: 'rate_limited', message: 'troppe richieste', retryAfterSeconds: 42 }, 429),
  );
  const http = new HttpClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  await assert.rejects(
    () => http.requestJson('/api/music/audius/tracks/x/download', { method: 'POST' }),
    (err: unknown) => {
      assert.ok(err instanceof SolcoApiError);
      assert.equal(err.isRateLimited, true);
      assert.equal(err.retryAfterSeconds, 42);
      return true;
    },
  );
});

test('il barattolo assorbe Set-Cookie dalla risposta', async () => {
  const jar = new CookieJar();
  const rec = recorder(() =>
    json({ ok: true }, 200, { 'set-cookie': 'session=fresh; Path=/; HttpOnly' }),
  );
  const http = new HttpClient({
    baseUrl: 'https://example.test',
    fetch: rec.fetch,
    cookieJar: jar,
  });
  await http.requestJson('/api/auth/sign-in/email', { method: 'POST', body: {} });
  assert.equal(jar.toJSON().session, 'fresh');
});

test('requestBinary restituisce byte e header', async () => {
  const rec = recorder(
    () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'x-solco-download': 'eyJ9' },
      }),
  );
  const http = new HttpClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  const res = await http.requestBinary('/api/music/audius/tracks/x/download', { method: 'POST' });
  assert.deepEqual([...res.bytes], [1, 2, 3]);
  assert.equal(res.contentType, 'audio/mpeg');
  assert.equal(res.headers.get('x-solco-download'), 'eyJ9');
});
