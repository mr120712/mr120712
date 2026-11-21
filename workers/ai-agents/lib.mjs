// @polsia:user-owned — logic for Solco's AI performance agents (Render Cron Job, no public port).
// Zero dependencies, Node 20+. Every network call goes through an injected `fetch`, so the tests run
// without a network. Keys are read from the environment and never logged (see redact()).
import { createHash } from 'node:crypto';

export const SOLCO_ORIGIN = 'https://www.solcomusic.online';
export const SOLCO_RESERVE_URL = `${SOLCO_ORIGIN}/api/ai-reserve/v1`;
/** MWAPI, a third-party AI gateway (OpenAI-compatible /v1/chat/completions). */
export const MWAPI_URL = 'https://api.mwapi.dev/v1';
const SOLCO_HOSTS = new Set(['solcomusic.online', 'www.solcomusic.online']);
const USER_AGENT = 'SolcoPerfAgents/1.0 (+render-cron)';

/** Public pages the review measures by default (from src/lib/nav.ts). */
export const DEFAULT_PAGES = ['/', '/search', '/radio', '/podcasts', '/generi', '/piani', '/app', '/blog'];
/** API endpoints the review times (Solco, its AI reserve, the Render yt-dlp worker). */
export const DEFAULT_APIS = [
  `${SOLCO_ORIGIN}/health`,
  `${SOLCO_ORIGIN}/api/ai-reserve/health`,
  'https://s2a76b51c9520ac.onrender.com/health',
];

// ─────────────────────────────────────────────────────────── backends (where the agents think)

/**
 * Which LLM endpoints the agents may use, in order. Security policy, enforced before any request:
 * - the PRIVATE FreeLLMAPI on Render's private network: http(s) to a single-label host (no dots,
 *   e.g. `http://freellmapi:3001/v1`). Not reachable from the internet; your license stays there.
 * - Solco's reserve: HTTPS on solcomusic.online only.
 * - MWAPI: exactly https://api.mwapi.dev/v1.
 * Anything else (a public host, an IP, localhost, a non-/v1 path) is refused, so no key is ever sent
 * outside these two places.
 */
export function backendPolicy(raw, kind) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: 'credentials, query or fragment in the URL' };
  }
  const host = url.hostname.toLowerCase();
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  if (!/\/v1$/.test(url.pathname.replace(/\/+$/, ''))) return { ok: false, reason: 'path must end in /v1' };
  if (kind === 'mwapi') {
    return url.protocol === 'https:' && host === 'api.mwapi.dev' && base === MWAPI_URL
      ? { ok: true, base }
      : { ok: false, reason: 'MWAPI must be https://api.mwapi.dev/v1' };
  }
  if (kind === 'private') {
    const singleLabel = /^[a-z0-9][a-z0-9-]{0,62}$/.test(host) && host !== 'localhost';
    if (!singleLabel) return { ok: false, reason: 'private backend must be a Render private-network host' };
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'bad scheme' };
    return { ok: true, base };
  }
  if (url.protocol !== 'https:' || !SOLCO_HOSTS.has(host)) {
    return { ok: false, reason: 'the reserve must be https on solcomusic.online' };
  }
  return { ok: true, base };
}

/**
 * The backends from the environment, in order: MWAPI key 1 and key 2, your private FreeLLMAPI,
 * then Solco's reserve. Throws if none passes the policy.
 */
export function backendsFrom(env) {
  const backends = [];
  const errors = [];
  const mwapiModel = env.MWAPI_MODEL?.trim() || 'auto';
  for (const [name, key] of [
    ['mwapi', env.MWAPI_API_KEY],
    ['mwapi-2', env.MWAPI_API_KEY_2],
  ]) {
    if (key?.trim()) backends.push({ name, base: MWAPI_URL, key: key.trim(), model: mwapiModel });
  }
  if (env.FREELLMAPI_PRIVATE_URL?.trim()) {
    const p = backendPolicy(env.FREELLMAPI_PRIVATE_URL, 'private');
    if (p.ok) {
      backends.push({
        name: 'freellmapi-private',
        base: p.base,
        key: env.FREELLMAPI_PRIVATE_KEY?.trim() || '',
        model: env.FREELLMAPI_PRIVATE_MODEL?.trim() || 'auto',
      });
    } else errors.push(`FREELLMAPI_PRIVATE_URL refused: ${p.reason}`);
  }
  const reserveKey = (env.SOLCO_RESERVE_KEY || env.FREELLMAPI_API_KEY || env.FREELLMAPI_TOKEN || '').trim();
  if (reserveKey) {
    const p = backendPolicy(env.SOLCO_RESERVE_URL?.trim() || SOLCO_RESERVE_URL, 'reserve');
    if (p.ok) backends.push({ name: 'solco-reserve', base: p.base, key: reserveKey, model: 'auto' });
    else errors.push(`SOLCO_RESERVE_URL refused: ${p.reason}`);
  }
  if (backends.length === 0) {
    throw new Error(
      `no usable AI backend (${errors.join('; ') || 'set MWAPI_API_KEY / MWAPI_API_KEY_2, FREELLMAPI_PRIVATE_URL or SOLCO_RESERVE_KEY'})`,
    );
  }
  return { backends, warnings: errors };
}

/** Model ids preferred when a gateway is asked for «auto» (cheap, fast, good at short reports). */
const PREFERRED_MODELS = [
  /gpt-4o-mini/i,
  /gpt-4\.1-mini/i,
  /gemini-[\d.]+-flash(?!-lite)/i,
  /claude-[\w.-]*haiku/i,
  /deepseek-(chat|v3)/i,
  /qwen[\w.-]*(plus|turbo|instruct)/i,
  /llama-3\.3-70b/i,
];
const NOT_CHAT = /(embed|whisper|tts|dall-e|image|moderation|rerank|audio|realtime|vision-preview)/i;

/**
 * A gateway such as MWAPI has no model called «auto»: ask its /models with the backend's key and
 * pick a real one (first match in PREFERRED_MODELS, else the first chat model listed). Backends with
 * an explicit model, or that are not MWAPI, are left as they are. Returns { backends, notes }; the
 * notes list the models found (ids only, never a key) so the owner can set MWAPI_MODEL.
 */
export async function resolveAutoModels(backends, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const notes = [];
  const out = [];
  for (const backend of backends) {
    if (backend.model !== 'auto' || !backend.name.startsWith('mwapi')) {
      out.push(backend);
      continue;
    }
    let ids = [];
    try {
      const res = await fetchImpl(`${backend.base}/models`, {
        headers: { authorization: `Bearer ${backend.key}`, 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = res.ok ? await res.json().catch(() => null) : null;
      ids = Array.isArray(data?.data) ? data.data.map((m) => String(m?.id ?? '')).filter(Boolean) : [];
      if (!res.ok) notes.push(`${backend.name}: /models HTTP ${res.status}`);
    } catch (error) {
      notes.push(`${backend.name}: /models ${error?.name || 'network error'}`);
    }
    const chatIds = ids.filter((id) => !NOT_CHAT.test(id));
    const chosen = PREFERRED_MODELS.map((re) => chatIds.find((id) => re.test(id))).find(Boolean) ?? chatIds[0];
    if (ids.length) notes.push(`${backend.name}: ${ids.length} modelli (${ids.slice(0, 25).join(', ')}${ids.length > 25 ? ', …' : ''})`);
    if (chosen) {
      notes.push(`${backend.name}: uso il modello ${chosen} (imposta MWAPI_MODEL per sceglierne un altro)`);
      out.push({ ...backend, model: chosen });
    } else {
      notes.push(`${backend.name}: nessun modello di chat trovato, salto questo backend`);
    }
  }
  return { backends: out, notes };
}

/** Removes every secret value from a string before it is logged or sent anywhere. */
export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * One chat completion with failover: each backend gets `attempts` tries (a 429/5xx/timeout is
 * retried, a 4xx is not), then the next backend. Returns { text, backend }.
 */
export async function chat(messages, backends, { fetchImpl = fetch, timeoutMs = 60_000, attempts = 2, maxTokens = 900 } = {}) {
  const failures = [];
  for (const backend of backends) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(`${backend.base}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
            ...(backend.key ? { authorization: `Bearer ${backend.key}` } : {}),
          },
          body: JSON.stringify({ model: backend.model, messages, max_tokens: maxTokens, temperature: 0.2 }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        failures.push(`${backend.name}: ${error?.name || 'network error'}`);
        continue; // timeout or network: retry, then next backend
      }
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim()) return { text: text.trim(), backend: backend.name };
        failures.push(`${backend.name}: empty answer`);
        break;
      }
      await res.body?.cancel?.().catch(() => undefined);
      failures.push(`${backend.name}: HTTP ${res.status}`);
      if (!(res.status === 429 || res.status >= 500)) break; // 401/403/400: retrying will not help
    }
  }
  const error = new Error(`all AI backends failed (${failures.join(', ')})`);
  error.failures = failures;
  throw error;
}

// ─────────────────────────────────────────────────────────── Solco's own anti-bot gate (UAM)


const CHALLENGE = /c1\.\d{1,12}\.(\d{1,2})\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/;

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** The proof-of-work the loading screen does: the first n with SHA-256(`challenge:n`) ≥ difficulty zero bits. */
export function solveChallenge(challenge, difficulty, maxTries = 2 ** 26) {
  for (let n = 0; n < maxTries; n += 1) {
    if (leadingZeroBits(createHash('sha256').update(`${challenge}:${n}`).digest()) >= difficulty) return String(n);
  }
  return null;
}

/**
 * Solco's UAM gate answers clients without clearance with a proof-of-work page. Like the loading
 * screen, solve it and post it to /api/uam/verify from the same origin; the clearance cookie is bound
 * to this client's address and User-Agent. Returns { cookie, gateMs, difficulty } or { cookie: null }.
 * The gate is not weakened: this is the same work every browser does.
 */
export async function passGate(origin, fetchImpl, userAgent = USER_AGENT) {
  const started = performance.now();
  let page;
  try {
    page = await fetchImpl(new URL('/', origin).href, { headers: { 'user-agent': userAgent }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    return { cookie: null, reason: error?.name || 'network error' };
  }
  if (page.headers.get('x-solco-gate') !== 'challenge') {
    await page.body?.cancel?.().catch(() => undefined);
    return { cookie: null, reason: 'no gate' };
  }
  const match = (await page.text()).match(CHALLENGE);
  if (!match) return { cookie: null, reason: 'challenge not found' };
  const difficulty = Number(match[1]);
  const solution = solveChallenge(match[0], difficulty);
  if (solution === null) return { cookie: null, reason: 'not solved', difficulty };
  const res = await fetchImpl(new URL('/api/uam/verify', origin).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'user-agent': userAgent },
    body: JSON.stringify({ challenge: match[0], solution }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  const setCookie = res?.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  return {
    cookie: res?.ok && cookie ? cookie : null,
    reason: res?.ok ? undefined : `verify ${res?.status ?? 'failed'}`,
    difficulty,
    gateMs: Math.round(performance.now() - started),
  };
}

// ─────────────────────────────────────────────────────────── measurements (facts, not opinions)

const pick = (headers, names) =>
  Object.fromEntries(names.map((n) => [n, headers.get(n)]).filter(([, v]) => v !== null));

const PAGE_HEADERS = ['cache-control', 'age', 'x-vercel-cache', 'content-encoding', 'content-type', 'etag', 'server-timing', 'x-matched-path'];

/** Parses the bits of HTML that matter for performance (no DOM library: regexes on our own site). */
export function parseHtml(html, pageUrl) {
  const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? null;
  const tags = (name) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? [];
  const sameOrigin = (src) => {
    try {
      const u = new URL(src, pageUrl);
      return u.origin === new URL(pageUrl).origin ? u.href : null;
    } catch {
      return null;
    }
  };
  const scripts = tags('script');
  const links = tags('link');
  const images = tags('img');
  return {
    htmlBytes: Buffer.byteLength(html),
    blocked: /<title>\s*Vercel Security Checkpoint/i.test(html),
    scriptsExternal: scripts.map((t) => attr(t, 'src')).filter(Boolean).map(sameOrigin).filter(Boolean),
    scriptsInline: scripts.filter((t) => !attr(t, 'src')).length,
    scriptsAsyncOrDefer: scripts.filter((t) => /\b(async|defer)\b/i.test(t) || /type=["']module/i.test(t)).length,
    stylesheets: links.filter((t) => /rel=["']stylesheet/i.test(t)).map((t) => sameOrigin(attr(t, 'href'))).filter(Boolean),
    preloads: links.filter((t) => /rel=["'](preload|modulepreload|preconnect)/i.test(t)).length,
    fontPreloads: links.filter((t) => /as=["']font/i.test(t)).length,
    images: images.length,
    imagesLazy: images.filter((t) => /loading=["']lazy/i.test(t)).length,
    imagesWithoutSize: images.filter((t) => !attr(t, 'width') || !attr(t, 'height')).length,
    hasViewport: /<meta[^>]+name=["']viewport/i.test(html),
    hasManifest: /rel=["']manifest/i.test(html),
  };
}

/** Times one GET: time to headers (≈TTFB) and to the full body. Never follows to another origin. */
export async function timedGet(url, fetchImpl, timeoutMs = 20_000, cookie = null) {
  const started = performance.now();
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'gzip, br', ...(cookie ? { cookie } : {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ttfbMs = Math.round(performance.now() - started);
    const body = await res.text();
    return {
      url,
      status: res.status,
      ttfbMs,
      totalMs: Math.round(performance.now() - started),
      bytes: Buffer.byteLength(body),
      headers: pick(res.headers, [...PAGE_HEADERS, 'x-solco-gate']),
      body,
    };
  } catch (error) {
    return { url, status: null, error: error?.name || 'network error', totalMs: Math.round(performance.now() - started) };
  }
}

/** Measures the pages, their same-origin JS/CSS (deduplicated, capped) and the API endpoints. */
export async function measure({ origin = SOLCO_ORIGIN, pages = DEFAULT_PAGES, apis = DEFAULT_APIS, fetchImpl = fetch, maxAssets = 30, solveGate = true } = {}) {
  const gate = solveGate ? await passGate(origin, fetchImpl) : { cookie: null, reason: 'off' };
  const cookie = gate.cookie;
  const pageResults = [];
  const assetUrls = new Map(); // url → kind
  for (const path of pages) {
    const r = await timedGet(new URL(path, origin).href, fetchImpl, 20_000, cookie);
    const html = typeof r.body === 'string' && /html/i.test(r.headers?.['content-type'] ?? '') ? parseHtml(r.body, r.url) : null;
    if (html) {
      for (const u of html.scriptsExternal) assetUrls.set(u, 'script');
      for (const u of html.stylesheets) assetUrls.set(u, 'stylesheet');
    }
    const { body, ...rest } = r;
    pageResults.push({ path, ...rest, html: html && { ...html, scriptsExternal: html.scriptsExternal.length, stylesheets: html.stylesheets.length } });
  }
  const assets = [];
  for (const [url, kind] of [...assetUrls].slice(0, maxAssets)) {
    const { body, ...rest } = await timedGet(url, fetchImpl, 20_000, cookie);
    assets.push({ kind, path: new URL(url).pathname, ...rest });
  }
  const apiResults = [];
  for (const url of apis) {
    const { body, ...rest } = await timedGet(url, fetchImpl);
    apiResults.push(rest);
  }
  const sw = await timedGet(new URL('/sw.js', origin).href, fetchImpl);
  delete sw.body;
  const { cookie: _secret, ...gateFacts } = gate; // the clearance cookie never leaves this function
  return { origin, measuredAt: new Date().toISOString(), gate: gateFacts, pages: pageResults, assets, apis: apiResults, serviceWorker: sw };
}

// ─────────────────────────────────────────────────────────── the agents

/** 7 specialists, each sees only the facts for its area (small prompts fit free models). */
export const SPECIALISTS = [
  { id: 'server', title: 'Risposta del server (TTFB)', facts: (m) => ({ antiBotGate: m.gate, pages: m.pages.map(({ path, status, ttfbMs, totalMs, headers, error }) => ({ path, status, ttfbMs, totalMs, cache: headers?.['x-vercel-cache'], age: headers?.age, gate: headers?.['x-solco-gate'], error })) }) },
  { id: 'caching', title: 'Cache e CDN', facts: (m) => ({ pages: m.pages.map(({ path, headers }) => ({ path, ...headers })), assets: m.assets.map(({ path, headers }) => ({ path, cacheControl: headers?.['cache-control'], cache: headers?.['x-vercel-cache'] })) }) },
  { id: 'javascript', title: 'Peso del JavaScript', facts: (m) => ({ perPage: m.pages.map(({ path, html }) => ({ path, external: html?.scriptsExternal, inline: html?.scriptsInline, asyncOrDefer: html?.scriptsAsyncOrDefer })), scripts: m.assets.filter((a) => a.kind === 'script').map(({ path, bytes, totalMs, headers }) => ({ path, bytes, totalMs, encoding: headers?.['content-encoding'] })) }) },
  { id: 'css-fonts', title: 'CSS, font e risorse bloccanti', facts: (m) => ({ perPage: m.pages.map(({ path, html }) => ({ path, stylesheets: html?.stylesheets, preloads: html?.preloads, fontPreloads: html?.fontPreloads })), stylesheets: m.assets.filter((a) => a.kind === 'stylesheet').map(({ path, bytes, headers }) => ({ path, bytes, encoding: headers?.['content-encoding'] })) }) },
  { id: 'images', title: 'Immagini', facts: (m) => m.pages.map(({ path, html }) => ({ path, images: html?.images, lazy: html?.imagesLazy, withoutWidthHeight: html?.imagesWithoutSize })) },
  { id: 'apis', title: 'API e worker (Solco, riserva AI, worker yt-dlp su Render)', facts: (m) => m.apis.map(({ url, status, ttfbMs, totalMs, error }) => ({ url, status, ttfbMs, totalMs, error })) },
  { id: 'html-mobile', title: 'HTML, mobile e PWA', facts: (m) => ({ pages: m.pages.map(({ path, bytes, html }) => ({ path, htmlBytes: bytes, viewport: html?.hasViewport, manifest: html?.hasManifest, blockedByFirewall: html?.blocked })), serviceWorker: { status: m.serviceWorker.status, headers: m.serviceWorker.headers } }) },
];

const SYSTEM = (language) =>
  `Sei un ingegnere delle prestazioni web e revisioni Solco, un sito Next.js 16 su Vercel. ` +
  `Usa SOLO le misure che ricevi: non inventare numeri, pagine o file. Se un dato manca, dillo. ` +
  `Rispondi in ${language}, conciso: massimo 6 punti, ognuno con il problema, la misura che lo prova ` +
  `e una correzione concreta. Se tutto è già buono nella tua area, dillo in una riga.`;

const clip = (value, max = 6000) => {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…(troncato)` : text;
};

/** Runs `tasks` with at most `limit` in flight (free tiers dislike bursts). */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function lane() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
  return results;
}

/** The 7 specialists in parallel, then the 8th (lead) agent merges them into one prioritized plan. */
export async function runReview(measurements, backends, { fetchImpl = fetch, concurrency = 3, language = 'italiano', timeoutMs } = {}) {
  const specialists = await pool(
    SPECIALISTS.map((agent) => async () => {
      try {
        const { text, backend } = await chat(
          [
            { role: 'system', content: SYSTEM(language) },
            { role: 'user', content: `Area: ${agent.title}\nMisure (JSON):\n${clip(agent.facts(measurements))}` },
          ],
          backends,
          { fetchImpl, timeoutMs },
        );
        return { id: agent.id, title: agent.title, ok: true, backend, text };
      } catch (error) {
        return { id: agent.id, title: agent.title, ok: false, text: '', error: error.message };
      }
    }),
    concurrency,
  );
  const answered = specialists.filter((s) => s.ok);
  if (answered.length === 0) {
    const error = new Error(`no agent got an answer: ${specialists[0]?.error ?? 'unknown'}`);
    error.specialists = specialists;
    throw error;
  }
  const lead = await chat(
    [
      { role: 'system', content: SYSTEM(language) },
      {
        role: 'user',
        content:
          `Sei il capo squadra. Unisci i rapporti degli specialisti in UN piano: le 10 correzioni ` +
          `più utili in ordine di impatto, ognuna con impatto (alto/medio/basso), sforzo e la misura ` +
          `che la giustifica. Scarta i doppioni e ciò che non è provato dalle misure.\n\n` +
          answered.map((s) => `## ${s.title}\n${s.text}`).join('\n\n'),
      },
    ],
    backends,
    { fetchImpl, timeoutMs, maxTokens: 1400 },
  ).catch((error) => ({ text: '', backend: null, error: error.message }));
  return { specialists, lead };
}

/** The final report as plain text (Telegram-safe, no markup). */
export function renderReport(measurements, review) {
  const lines = [`Solco — revisione prestazioni (${measurements.measuredAt})`, ''];
  const slow = [...measurements.pages].filter((p) => typeof p.ttfbMs === 'number').sort((a, b) => b.ttfbMs - a.ttfbMs)[0];
  if (slow) lines.push(`Pagina più lenta a rispondere: ${slow.path} (${slow.ttfbMs} ms al primo byte)`);
  if (measurements.gate?.gateMs) {
    lines.push(`Verifica anti-bot di Solco superata in ${measurements.gate.gateMs} ms (difficoltà ${measurements.gate.difficulty} bit)`);
  }
  const gated = measurements.pages.filter((p) => p.headers?.['x-solco-gate']).map((p) => p.path);
  if (gated.length) lines.push(`Attenzione: misurata la pagina di verifica anti-bot, non la pagina vera, per ${gated.join(', ')}`);
  const blocked = measurements.pages.filter((p) => p.html?.blocked).map((p) => p.path);
  if (blocked.length) lines.push(`Attenzione: il firewall di Vercel ha bloccato la misura di ${blocked.join(', ')}`);
  lines.push('', '== Piano (capo squadra) ==', review.lead.text || `non disponibile (${review.lead.error ?? 'nessuna risposta'})`, '');
  for (const s of review.specialists) {
    lines.push(`== ${s.title}${s.ok ? ` [${s.backend}]` : ''} ==`, s.ok ? s.text : `nessuna risposta (${s.error})`, '');
  }
  return lines.join('\n');
}

/** Splits text into Telegram-sized chunks (limit 4096), on line boundaries when possible. */
export function chunks(text, size = 3900) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}
