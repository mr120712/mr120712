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
  retryDelayMs,
  resolveAutoModels,
  runReview,
  SPECIALISTS,
  solveChallenge,
} from './lib.mjs';
import { createHash } from 'node:crypto';
import { AD_SCREENS, AD_SPECIALISTS, collectAdFacts, parseStoryboard } from './tiktok-ad.mjs';
import { collectWorker, extractPython, WORKER_SPECIALISTS } from './worker-review.mjs';

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
  const waits = [];
  const out = await chat([{ role: 'user', content: 'x' }], backends, { fetchImpl, timeoutMs: 1000, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(out, { text: 'ciao', backend: 'solco-reserve', model: 'auto' });
  assert.deepEqual(waits, [2000, 4000]); // backed off after each 503 instead of retrying at once
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
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push(`${new URL(url).hostname} ${init.headers.authorization}`);
      return init.headers.authorization === 'Bearer mw-key-1' ? json({ error: 'quota' }, 429) : answer('da mwapi 2');
    },
  });
  assert.deepEqual(out, { text: 'da mwapi 2', backend: 'mwapi-2', model: 'claude-sonnet-5' });
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

test('worker review: functions extracted by name, 4 specialists + lead, each sees only its code', async () => {
  const py = [
    'import os',
    'LIMIT = 5',
    '',
    'def _base_opts():',
    '    return {"a": 1}',
    '',
    '@app.get("/health")',
    'def health():',
    '    return {}',
    '',
    'class WarpExit:',
    '    def renew(self):',
    '        pass',
    '',
    'X = 1',
  ].join('\n');
  assert.equal(extractPython(py, ['__header__']), 'import os\nLIMIT = 5\n');
  assert.equal(extractPython(py, ['health']), '@app.get("/health")\ndef health():\n    return {}');
  assert.match(extractPython(py, ['WarpExit']), /def renew/);
  assert.doesNotMatch(extractPython(py, ['WarpExit']), /X = 1/);
  assert.equal(extractPython(py, ['missing']), '');

  // Real files from the repo, fake /health
  const m = await collectWorker({
    root: new URL('../../', import.meta.url),
    fetchImpl: async () => json({ ok: true, antibot: { last: { status: 'ok', exit: 'warp', attempts: 1, seconds: 9.5 } } }),
  });
  assert.ok(m.files.app.includes('def _run_with_antibot'));
  assert.equal(m.health.antibot.last.exit, 'warp');
  assert.equal(WORKER_SPECIALISTS.length, 4);
  const facts = Object.fromEntries(WORKER_SPECIALISTS.map((a) => [a.id, a.facts(m)]));
  assert.match(facts.antibot, /def _run_with_antibot/);
  assert.match(facts.antibot, /"exit":"warp"/);
  assert.doesNotMatch(facts.pipeline, /class WarpExit/);
  assert.match(facts.startup, /FROM python/);
  assert.doesNotMatch(facts.startup, /solco-ai-agents/); // only the worker's service from render.yaml
  for (const text of Object.values(facts)) assert.ok(text.length < 24_000, 'each agent fits its budget');

  const prompts = [];
  const ai = async (_url, init) => {
    const { messages } = JSON.parse(init.body);
    prompts.push(messages);
    return answer(messages.at(-1).content.startsWith('Sei il capo') ? 'PIANO WORKER' : 'ok');
  };
  const backends = [{ name: 'mwapi', base: 'https://api.mwapi.dev/v1', key: 'mw-key-1', model: 'claude-sonnet-5' }];
  const review = await runReview(m, backends, { fetchImpl: ai, specialists: WORKER_SPECIALISTS, subject: 'SUBJ worker', clipChars: 24_000 });
  assert.equal(review.specialists.length, 4);
  assert.equal(review.lead.text, 'PIANO WORKER');
  assert.ok(prompts.every((msgs) => msgs[0].content.startsWith('SUBJ worker')));
  assert.match(renderReport(m, review, 'Worker yt-dlp — revisione prestazioni'), /^Worker yt-dlp/);
});

test('TikTok ad: 6 specialists, facts from the repo (Pro not advertised), storyboard validated', async () => {
  assert.equal(AD_SPECIALISTS.length, 6);
  const f = await collectAdFacts({
    root: new URL('../../', import.meta.url),
    fetchImpl: async (url) =>
      new Response(`<html><title>Solco</title><h1>Tutta la musica</h1><p>10 iscritti a Solco</p><ul><li>Gratis</li><li>40 ascolti al mese</li><li>Radio e YouTube senza limiti</li></ul><script>x()</script></html>`, {
        headers: { 'content-type': 'text/html' },
      }),
  });
  assert.equal(f.facts.name, 'Solco');
  assert.match(f.facts.description, /radio dal vivo e podcast/i);
  assert.equal(f.facts.proOnSale, false); // the checkout is blocked in solco-pro-billing.ts
  assert.match(f.text, /NON pubblicizzarlo/);
  assert.ok(f.facts.sections.includes('Radio'));
  assert.ok(!f.facts.sections.includes('Privacy'));
  assert.match(f.text, /40 ascolti al mese/); // the Free plan's limit reaches the compliance agent
  assert.match(f.text, /Radio e YouTube senza limiti/);
  assert.doesNotMatch(f.text, /iscritti a Solco/); // the live counter is left out
  assert.doesNotMatch(f.text, /x\(\)/);

  const board = parseStoryboard(
    'Ecco:\n```json\n' +
      JSON.stringify({
        title: 'Tutta la tua musica',
        durationSeconds: 15,
        scenes: [
          { start: 0, end: 2, screen: 'logo', motion: 'zoom-in', headline: 'Musica, radio e podcast' },
          { start: 2, end: 5, screen: 'hero', motion: 'pan-down', headline: 'Radio dal vivo', subline: 'in un tap' },
          { start: 5, end: 8, screen: '/radio', motion: 'spin', headline: 'schermo non visibile: scartato' },
          { start: 8, end: 11, screen: 'text', motion: 'spin', headline: 'x'.repeat(80) },
          { start: 11, end: 14, screen: 'free-plan', motion: 'pan-up', headline: 'Inizia gratis' },
        ],
        cta: 'Ascolta gratis ora',
        hashtags: ['musica', '#radio!', 'podcast', 'a', 'b', 'c'],
        music: { mood: 'lo-fi energico', bpm: 118, librarySearch: 'upbeat lofi' },
        compliance: ['ok'],
      }) +
      '\n```',
  );
  assert.deepEqual(board.scenes.map((s) => s.screen), ['logo', 'hero', 'text', 'free-plan', 'end-card']);
  assert.equal(board.scenes[0].start, 0);
  for (let i = 1; i < board.scenes.length; i += 1) assert.equal(board.scenes[i].start, board.scenes[i - 1].end);
  assert.equal(board.scenes[2].motion, 'static'); // unknown motion → static
  assert.equal(board.scenes[2].headline.length, 32);
  assert.equal(board.durationSeconds, board.scenes.at(-1).end);
  assert.deepEqual(board.hashtags, ['#musica', '#radio', '#podcast', '#a', '#b']);
  assert.ok(board.scenes.every((s) => AD_SCREENS.includes(s.screen)));
  assert.throws(() => parseStoryboard('nessun json'), /JSON valido/);
  assert.throws(() => parseStoryboard('```json\n{"scenes":[]}\n```'), /almeno 3 scene/);
});

test('MagnetAPI: agents only, exact address, first in line, best real model from /v1/models', async () => {
  assert.equal(backendPolicy('https://api.magnetapi.org/v1', 'magnetapi').ok, true);
  for (const bad of ['http://api.magnetapi.org/v1', 'https://magnetapi.org/v1', 'https://api.magnetapi.org.evil.example/v1', 'https://api.magnetapi.org/v2']) {
    assert.equal(backendPolicy(bad, 'magnetapi').ok, false, bad);
  }
  const { backends } = backendsFrom({ MAGNETAPI_API_KEY: 'mg-key-1', MWAPI_API_KEY: 'mw-key-1', SOLCO_RESERVE_KEY: 'reserve-key' });
  assert.deepEqual(backends.map((b) => b.name), ['magnetapi', 'mwapi', 'solco-reserve']);
  assert.equal(backends[0].model, 'auto');
  assert.equal(backendsFrom({ MAGNETAPI_API_KEY: 'mg-key-1', MAGNETAPI_MODEL: 'gpt-6-1-sol' }).backends[0].model, 'gpt-6-1-sol');

  // Only ids the key really lists; GPT 6.2 first (the owner's choice), then Opus 5.5, Fable 5.2, GPT 6.1.
  const chain = async (ids) =>
    (await resolveAutoModels([backends[0]], { fetchImpl: async () => json({ data: ids.map((id) => ({ id })) }) })).backends.map((b) => b.model);
  const real = ['gemini-4-hydrogen', 'gemini-4-carbon', 'deepseek-flash', 'gemini-4-argon', 'gpt-6.1-sol', 'gpt-6.2-sol', 'claude-sonnet-5-5', 'gpt-6-sol', 'power-ai', 'gpt-6-astra', 'gpt-5.6-sol', 'claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-1'];
  assert.deepEqual(await chain(real), ['gpt-6.2-sol', 'claude-opus-5-5', 'claude-fable-5-2', 'gpt-6.1-sol']);
  assert.deepEqual(await chain(['claude-sonnet-5-5', 'gpt-6-astra', 'claude-opus-5-5', 'text-embedding-3']), ['claude-opus-5-5', 'gpt-6-astra', 'claude-sonnet-5-5']);
  assert.deepEqual(await chain(['deepseek-chat', 'claude-sonnet-5']), ['claude-sonnet-5', 'deepseek-chat']);
  assert.deepEqual(await chain(['whisper-1', 'some-model']), ['some-model']);

  // The chain fails over model by model on the same key: GPT 6.2 refused (400) → Opus answers.
  const asked = [];
  const out = await chat(
    [{ role: 'user', content: 'x' }],
    (await resolveAutoModels([backends[0]], { fetchImpl: async () => json({ data: real.map((id) => ({ id })) }) })).backends,
    {
      fetchImpl: async (_url, init) => {
        const { model } = JSON.parse(init.body);
        asked.push(model);
        return model === 'gpt-6.2-sol' ? json({ error: 'model_not_available' }, 400) : answer(`da ${model}`);
      },
    },
  );
  assert.equal(out.text, 'da claude-opus-5-5');
  assert.deepEqual(asked, ['gpt-6.2-sol', 'claude-opus-5-5']);

  // The models list is logged for the owner (ids only, never the key).
  const { notes } = await resolveAutoModels([backends[0]], {
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, 'Bearer mg-key-1');
      return json({ data: [{ id: 'claude-opus-5-5' }, { id: 'gpt-6.1-sol' }] });
    },
  });
  assert.ok(notes.some((n) => n.includes('2 modelli') && n.includes('gpt-6.1-sol')));
  assert.ok(notes.some((n) => n.includes('catena claude-opus-5-5 → gpt-6.1-sol') && n.includes('MAGNETAPI_MODEL')));
  assert.ok(notes.every((n) => !n.includes('mg-key-1')));
});

test('429 from a reseller: honour Retry-After, back off within a budget, then the next backend', async () => {
  assert.equal(retryDelayMs(new Response('', { status: 429, headers: { 'retry-after': '7' } }), 1), 7000);
  assert.equal(retryDelayMs(new Response('', { status: 429 }), 1), 2000);
  assert.equal(retryDelayMs(new Response('', { status: 429 }), 3), 8000);
  assert.equal(retryDelayMs(new Response('', { status: 429, headers: { 'retry-after': '600' } }), 1), 20_000);

  const backends = [
    { name: 'magnetapi', base: 'https://api.magnetapi.org/v1', key: 'mg-1', model: 'gpt-6.2-sol' },
    { name: 'magnetapi', base: 'https://api.magnetapi.org/v1', key: 'mg-1', model: 'claude-opus-5-5' },
  ];
  // Busy on the first try, then GPT 6.2 answers after the wait (no need to change model).
  let n = 0;
  const waits = [];
  const out = await chat([{ role: 'user', content: 'x' }], backends, {
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async () => (n++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : answer('ok')),
  });
  assert.deepEqual(out, { text: 'ok', backend: 'magnetapi', model: 'gpt-6.2-sol' });
  assert.deepEqual(waits, [3000]);

  // Always 429: the waits stop at the budget, then the error names every attempt.
  const capped = [];
  await assert.rejects(
    chat([{ role: 'user', content: 'x' }], backends, {
      sleep: async (ms) => capped.push(ms),
      waitBudgetMs: 10_000,
      fetchImpl: async () => new Response('', { status: 429 }),
    }),
    /magnetapi: HTTP 429/,
  );
  assert.equal(capped.reduce((a, b) => a + b, 0), 10_000);
});

test('android-app: 6 specialists cover every Dart file of the Flutter app exactly once', async () => {
  const { readdir } = await import('node:fs/promises');
  const { collectFlutter, FLUTTER_SPECIALISTS } = await import('./flutter-review.mjs');
  assert.equal(FLUTTER_SPECIALISTS.length, 6);
  const root = new URL('../../', import.meta.url);
  const dart = (await readdir(new URL('flutter/lib/', root), { recursive: true }))
    .filter((f) => f.endsWith('.dart'))
    .map((f) => `flutter/lib/${f}`)
    .sort();
  const assigned = FLUTTER_SPECIALISTS.flatMap((a) => a.files).filter((f) => f.endsWith('.dart'));
  assert.equal(new Set(assigned).size, assigned.length, 'a file is read by two specialists');
  assert.deepEqual([...assigned].sort(), dart);
  const m = await collectFlutter({ root });
  assert.deepEqual(m.missing, []);
  const facts = FLUTTER_SPECIALISTS[1].facts(m);
  assert.match(facts, /===== flutter\/lib\/api\/solco_api\.dart =====/);
  assert.doesNotMatch(facts, /player_controller/);
});

test('login-wall: 5 specialists, real files read, and a meaningful gate map', async () => {
  const { collectLoginWall, gateMap, LOGIN_WALL_SPECIALISTS } = await import('./login-wall-review.mjs');
  assert.equal(LOGIN_WALL_SPECIALISTS.length, 5);
  const root = new URL('../../', import.meta.url);
  const m = await collectLoginWall({ root });
  assert.deepEqual(m.missing, []); // every referenced file exists
  assert.ok(m.routeCount > 100, `expected many routes, got ${m.routeCount}`);
  // Each specialist produces non-trivial material from its own files.
  for (const agent of LOGIN_WALL_SPECIALISTS) assert.ok(agent.facts(m).length > 500, agent.id);
  assert.match(LOGIN_WALL_SPECIALISTS[1].facts(m), /Mappa delle guardie/);

  // gateMap: a mutating route with no same-origin and no auth gets both flags; a gated GET gets none.
  const map = gateMap([
    { path: 'src/app/api/open/route.ts', source: 'export async function POST() {}' },
    { path: 'src/app/api/safe/route.ts', source: 'requireAuth; export async function GET() {}' },
    { path: 'src/app/api/admin/x/route.ts', source: 'requireAccountAdmin; sameOrigin; export async function DELETE() {}' },
  ]);
  assert.match(map.find((l) => l.startsWith('/api/open')), /⚠senza-sessione ⚠senza-same-origin/);
  assert.doesNotMatch(map.find((l) => l.startsWith('/api/safe')), /⚠/);
  assert.match(map.find((l) => l.startsWith('/api/admin/x')), /guardie: admin, same-origin/);
  assert.doesNotMatch(map.find((l) => l.startsWith('/api/admin/x')), /⚠/);
});
