// @polsia:user-owned — tests for the AI performance agents. No network: every fetch is faked.
// Run: node --test workers/ai-agents/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backendPolicy,
  backendsFrom,
  chat,
  chunks,
  measure,
  parseHtml,
  passGate,
  redact,
  renderReport,
  resolveAutoModels,
  runReview,
  SPECIALISTS,
  solveChallenge,
} from './lib.mjs';
import { createHash } from 'node:crypto';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = (text) => json({ choices: [{ message: { content: text } }] });

test('backend policy: only a Render private host or https Solco, path /v1', () => {
  assert.equal(backendPolicy('http://freellmapi:3001/v1', 'private').ok, true);
  assert.equal(backendPolicy('http://freellmapi-ab12:3001/v1/', 'private').base, 'http://freellmapi-ab12:3001/v1');
  for (const bad of [
    'http://localhost:3001/v1',
    'http://192.168.0.117:3001/v1',
    'https://evil.example/v1',
    'http://freellmapi:3001/v2',
    'http://user:pw@freellmapi:3001/v1',
  ]) {
    assert.equal(backendPolicy(bad, 'private').ok, false, bad);
  }
  assert.equal(backendPolicy('https://www.solcomusic.online/api/ai-reserve/v1', 'reserve').ok, true);
  for (const bad of [
    'http://www.solcomusic.online/api/ai-reserve/v1',
    'https://solcomusic.online.evil.example/api/ai-reserve/v1',
    'https://freellmapi/v1',
  ]) {
    assert.equal(backendPolicy(bad, 'reserve').ok, false, bad);
  }
});

test('backends: private first, reserve as fallback; refused URLs never become backends', () => {
  const { backends } = backendsFrom({
    FREELLMAPI_PRIVATE_URL: 'http://freellmapi:3001/v1',
    FREELLMAPI_PRIVATE_KEY: 'private-key-123',
    FREELLMAPI_TOKEN: 'reserve-key-456',
  });
  assert.deepEqual(backends.map((b) => b.name), ['freellmapi-private', 'solco-reserve']);
  const refused = backendsFrom({ FREELLMAPI_PRIVATE_URL: 'https://evil.example/v1', SOLCO_RESERVE_KEY: 'k-123456' });
  assert.deepEqual(refused.backends.map((b) => b.name), ['solco-reserve']);
  assert.match(refused.warnings[0], /refused/);
  assert.throws(() => backendsFrom({}), /no usable AI backend/);
});

test('redact removes every secret value', () => {
  assert.equal(redact('Bearer abcdef123 then abcdef123', ['abcdef123']), 'Bearer [redacted] then [redacted]');
  assert.equal(redact('short ab', ['ab']), 'short ab'); // too short to be a real key: left alone
});

test('chat: retries 5xx, skips a refusing backend, falls back, sends the Bearer only to its backend', async () => {
  const backends = [
    { name: 'freellmapi-private', base: 'http://freellmapi:3001/v1', key: 'priv-key-1', model: 'auto' },
    { name: 'solco-reserve', base: 'https://www.solcomusic.online/api/ai-reserve/v1', key: 'res-key-2', model: 'auto' },
  ];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (url.startsWith('http://freellmapi')) return json({ error: 'busy' }, 503);
    return answer('ciao');
  };
  const out = await chat([{ role: 'user', content: 'x' }], backends, { fetchImpl, timeoutMs: 1000 });
  assert.deepEqual(out, { text: 'ciao', backend: 'solco-reserve' });
  assert.equal(calls.length, 3); // two tries on the private one (503 is retryable), then the reserve
  assert.equal(calls[0].auth, 'Bearer priv-key-1');
  assert.equal(calls[2].auth, 'Bearer res-key-2');

  const refused = [];
  await assert.rejects(
    chat([{ role: 'user', content: 'x' }], backends.slice(1), {
      fetchImpl: async (url) => (refused.push(url), json({ error: 'unauthorized' }, 401)),
    }),
    /all AI backends failed \(solco-reserve: HTTP 401\)/,
  );
  assert.equal(refused.length, 1); // a 401 is not retried
});

test('parseHtml finds same-origin assets, lazy images and the firewall page', () => {
  const html =
    '<html><head><meta name="viewport" content="x"><link rel="manifest" href="/m.json">' +
    '<link rel="stylesheet" href="/a.css"><link rel="preload" as="font" href="/f.woff2">' +
    '<script src="/_next/a.js" async></script><script src="https://cdn.other/x.js"></script><script>inline()</script>' +
    '</head><body><img src="/i.png" loading="lazy" width="1" height="1"><img src="/j.png"></body></html>';
  const out = parseHtml(html, 'https://www.solcomusic.online/');
  assert.deepEqual(out.scriptsExternal, ['https://www.solcomusic.online/_next/a.js']);
  assert.equal(out.scriptsInline, 1);
  assert.deepEqual(out.stylesheets, ['https://www.solcomusic.online/a.css']);
  assert.equal(out.fontPreloads, 1);
  assert.equal(out.images, 2);
  assert.equal(out.imagesLazy, 1);
  assert.equal(out.imagesWithoutSize, 1);
  assert.equal(out.hasViewport, true);
  assert.equal(out.blocked, false);
  assert.equal(parseHtml('<title>Vercel Security Checkpoint</title>', 'https://x.y/').blocked, true);
});

test('measure + 7 specialists + lead produce a report; agents see only their facts', async () => {
  const site = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/') {
      return new Response('<html><script src="/_next/app.js"></script><img src="/a.png"></html>', {
        headers: { 'content-type': 'text/html', 'x-vercel-cache': 'MISS', 'cache-control': 'private, no-store' },
      });
    }
    if (pathname === '/_next/app.js') return new Response('x'.repeat(1234), { headers: { 'cache-control': 'public, max-age=31536000, immutable' } });
    return json({ ok: true });
  };
  const m = await measure({ pages: ['/'], apis: ['https://www.solcomusic.online/health'], fetchImpl: site });
  assert.equal(m.pages[0].html.scriptsExternal, 1);
  assert.equal(m.assets[0].bytes, 1234);
  assert.equal(m.apis[0].status, 200);

  const prompts = [];
  const ai = async (_url, init) => {
    const { messages } = JSON.parse(init.body);
    prompts.push(messages.at(-1).content);
    return answer(messages.at(-1).content.startsWith('Sei il capo') ? 'PIANO' : 'OK area');
  };
  const backends = [{ name: 'solco-reserve', base: 'https://www.solcomusic.online/api/ai-reserve/v1', key: 'k-123456', model: 'auto' }];
  const review = await runReview(m, backends, { fetchImpl: ai, concurrency: 2 });
  assert.equal(review.specialists.length, SPECIALISTS.length);
  assert.equal(SPECIALISTS.length + 1, 8); // 7 specialists + 1 lead
  assert.ok(review.specialists.every((s) => s.ok));
  assert.equal(review.lead.text, 'PIANO');
  const jsPrompt = prompts.find((p) => p.includes('Peso del JavaScript'));
  assert.match(jsPrompt, /"bytes":1234/);
  assert.doesNotMatch(prompts.find((p) => p.includes('Immagini')), /1234/); // the images agent never sees JS sizes
  const report = renderReport(m, review);
  assert.match(report, /Piano \(capo squadra\)/);
  assert.match(report, /PIANO/);
});

test('no backend answers → runReview throws (no invented report)', async () => {
  const m = { pages: [], assets: [], apis: [], serviceWorker: { status: 200, headers: {} }, measuredAt: 'now' };
  const backends = [{ name: 'solco-reserve', base: 'https://www.solcomusic.online/api/ai-reserve/v1', key: 'k-123456', model: 'auto' }];
  await assert.rejects(runReview(m, backends, { fetchImpl: async () => json({}, 401) }), /no agent got an answer/);
});

test('chunks respect the Telegram limit and keep everything', () => {
  const text = Array.from({ length: 300 }, (_, i) => `riga ${i} ${'x'.repeat(30)}`).join('\n');
  const parts = chunks(text, 1000);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(parts.join('\n').replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('the anti-bot gate: solve the proof-of-work like the loading screen, then measure with the cookie', async () => {
  const challenge = `c1.1795278539.12.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const solution = solveChallenge(challenge, 12);
  const digest = createHash('sha256').update(`${challenge}:${solution}`).digest();
  assert.equal(digest[0], 0); // 12 leading zero bits: first byte zero…
  assert.ok(digest[1] < 16); // …and the next nibble too

  const seen = [];
  const site = async (url, init = {}) => {
    const { pathname } = new URL(url);
    seen.push({ pathname, method: init.method ?? 'GET', cookie: init.headers?.cookie, origin: init.headers?.origin });
    if (pathname === '/api/uam/verify') {
      const body = JSON.parse(init.body);
      assert.equal(body.challenge, challenge);
      assert.equal('automation' in body, false);
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', 'solco_uam=v1.clear; Path=/; HttpOnly; Secure');
      return new Response('{"ok":true}', { status: 200, headers });
    }
    if (init.headers?.cookie !== 'solco_uam=v1.clear') {
      return new Response(`<html><script type="application/json">{"challenge":"${challenge}","difficulty":12}</script></html>`, {
        headers: { 'content-type': 'text/html', 'x-solco-gate': 'challenge' },
      });
    }
    return new Response('<html><script src="/_next/real.js"></script></html>', { headers: { 'content-type': 'text/html' } });
  };
  const gate = await passGate('https://www.solcomusic.online', site);
  assert.equal(gate.cookie, 'solco_uam=v1.clear');
  assert.equal(gate.difficulty, 12);
  assert.equal(seen.find((s) => s.pathname === '/api/uam/verify').origin, 'https://www.solcomusic.online');

  const m = await measure({ pages: ['/radio'], apis: [], fetchImpl: site });
  assert.equal(m.pages[0].html.scriptsExternal, 1); // the REAL page, not the challenge
  assert.equal(m.pages[0].headers['x-solco-gate'], undefined);
  assert.equal(JSON.stringify(m).includes('v1.clear'), false); // the cookie is never in the facts
});

test('no gate (or gate off) → measure without a cookie', async () => {
  const site = async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  const m = await measure({ pages: ['/'], apis: [], fetchImpl: site });
  assert.equal(m.gate.reason, 'no gate');
});

test('MWAPI: first, key 1 then key 2, only https://api.mwapi.dev/v1, model claude-sonnet-5 or MWAPI_MODEL', async () => {
  assert.equal(backendPolicy('https://api.mwapi.dev/v1', 'mwapi').ok, true);
  for (const bad of ['http://api.mwapi.dev/v1', 'https://mwapi.dev/v1', 'https://api.mwapi.dev/v2', 'https://api.mwapi.dev.evil.example/v1']) {
    assert.equal(backendPolicy(bad, 'mwapi').ok, false, bad);
  }
  const { backends } = backendsFrom({
    MWAPI_API_KEY: 'mw-key-1',
    MWAPI_API_KEY_2: 'mw-key-2',
    FREELLMAPI_PRIVATE_URL: 'http://freellmapi:3001/v1',
    SOLCO_RESERVE_KEY: 'reserve-key',
  });
  assert.deepEqual(backends.map((b) => b.name), ['mwapi', 'mwapi-2', 'freellmapi-private', 'solco-reserve']);
  assert.equal(backends[0].model, 'claude-sonnet-5'); // the owner's choice, unless MWAPI_MODEL says otherwise
  assert.equal(backendsFrom({ MWAPI_API_KEY: 'mw-key-1', MWAPI_MODEL: 'auto' }).backends[0].model, 'auto');
  assert.equal(backendsFrom({ MWAPI_API_KEY: 'mw-key-1', MWAPI_MODEL: 'gpt-4o-mini' }).backends[0].model, 'gpt-4o-mini');

  // key 1 exhausted (429 twice) → key 2 answers; the reserve is never called
  const calls = [];
  const out = await chat([{ role: 'user', content: 'x' }], backends, {
    fetchImpl: async (url, init) => {
      calls.push(`${new URL(url).hostname} ${init.headers.authorization}`);
      return init.headers.authorization === 'Bearer mw-key-1' ? json({ error: 'quota' }, 429) : answer('da mwapi 2');
    },
  });
  assert.deepEqual(out, { text: 'da mwapi 2', backend: 'mwapi-2' });
  assert.deepEqual(calls, ['api.mwapi.dev Bearer mw-key-1', 'api.mwapi.dev Bearer mw-key-1', 'api.mwapi.dev Bearer mw-key-2']);

  // model 'auto' refused (400) → no retry, the next backend takes over
  const refused = [];
  const next = await chat([{ role: 'user', content: 'x' }], backends.slice(1), {
    fetchImpl: async (url, init) => {
      refused.push(new URL(url).hostname);
      return new URL(url).hostname === 'api.mwapi.dev' ? json({ error: 'model_not_found' }, 400) : answer('da freellmapi');
    },
  });
  assert.equal(next.backend, 'freellmapi-private');
  assert.deepEqual(refused, ['api.mwapi.dev', 'freellmapi']);
});

test('«auto» on MWAPI: ask /models with the key, pick a real chat model, list the ids', async () => {
  const backends = [
    { name: 'mwapi', base: 'https://api.mwapi.dev/v1', key: 'mw-key-1', model: 'auto' },
    { name: 'mwapi-2', base: 'https://api.mwapi.dev/v1', key: 'mw-key-2', model: 'claude-3-5-haiku' },
    { name: 'solco-reserve', base: 'https://www.solcomusic.online/api/ai-reserve/v1', key: 'r-123456', model: 'auto' },
  ];
  const asked = [];
  const { backends: out, notes } = await resolveAutoModels(backends, {
    fetchImpl: async (url, init) => {
      asked.push(`${url} ${init.headers.authorization}`);
      return json({ data: [{ id: 'text-embedding-3-small' }, { id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
    },
  });
  assert.deepEqual(asked, ['https://api.mwapi.dev/v1/models Bearer mw-key-1']); // only the «auto» MWAPI one
  assert.deepEqual(out.map((b) => b.model), ['gpt-4o-mini', 'claude-3-5-haiku', 'auto']);
  assert.ok(notes.some((n) => n.includes('3 modelli') && n.includes('gpt-4o')));
  assert.ok(notes.every((n) => !n.includes('mw-key-1')));

  // no preferred match → first chat model; nothing usable → the backend is skipped
  const first = await resolveAutoModels([backends[0]], { fetchImpl: async () => json({ data: [{ id: 'whisper-1' }, { id: 'some-chat' }] }) });
  assert.equal(first.backends[0].model, 'some-chat');
  const none = await resolveAutoModels([backends[0]], { fetchImpl: async () => json({ error: 'x' }, 401) });
  assert.deepEqual(none.backends, []);
  assert.ok(none.notes.some((n) => n.includes('HTTP 401')));
});
