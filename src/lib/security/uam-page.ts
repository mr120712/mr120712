// @polsia:user-owned
//
// Solco "Under Attack Mode" — the loading screen served by the UAM gate
// (src/lib/security/uam-gate.ts) instead of the requested page, until the
// browser has solved a small proof of work and received the clearance cookie.
//
// Runs inside the proxy bundle: NO 'server-only', NO Node-only APIs, NO React.
// The page is one self-contained HTML document: inline <style>, an inline SVG
// mark, the challenge as a JSON data block and ONE nonce'd inline solver
// script. It loads nothing else (system fonts, no images), so it renders under
// the strict `uamPageCsp()` below and never depends on the app being healthy.
//
// The solver is a plain string on purpose (not a serialised function), so no
// bundler/transpiler can rewrite it. It only uses bare globals (`document`,
// `crypto`, `fetch`, `location`, `sessionStorage`, `navigator`) so the unit
// tests can run it with stubs.

export type UamPageMode = 'first-visit' | 'attack';

export interface UamPageInput {
  /** CSP nonce (base64) shared by the page's script tag and `uamPageCsp()`. */
  nonce: string;
  /** Signed challenge string issued by `issueChallenge()`. */
  challenge: string;
  /** Proof-of-work difficulty in leading zero bits. */
  difficulty: number;
  mode: UamPageMode;
}

/** sessionStorage key of the reload-loop guard (read by the inline solver). */
export const UAM_TRIES_KEY = 'solco-uam-tries';
/** Endpoint the solver posts `{ challenge, solution }` to. */
export const UAM_VERIFY_PATH = '/api/uam/verify';
/** The verify request (response + body) gives up after this long and offers "Riprova". */
export const UAM_VERIFY_TIMEOUT_MS = 20_000;

const NONCE_PATTERN = /^[A-Za-z0-9+/_-]{1,128}={0,2}$/;

function assertNonce(nonce: string): void {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
    // The gate catches this and fails open; never emit a CSP or a script tag
    // with an attacker-shaped nonce.
    throw new TypeError('uam-page: invalid nonce');
  }
}

/** Content-Security-Policy for the interstitial: only the nonce'd solver may run. */
export function uamPageCsp(nonce: string): string {
  assertNonce(nonce);
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * JSON for an inline `<script type="application/json">` block. `<`, `>` and
 * `&` become \uXXXX escapes, so no value can close the tag ("</script>") or
 * open a comment; U+2028/2029 are escaped for old JS parsers. JSON.parse
 * restores the original string.
 */
export function serializeUamData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function clampDifficulty(difficulty: number): number {
  const n = Math.trunc(Number(difficulty));
  if (!Number.isFinite(n)) return 1;
  return Math.min(32, Math.max(1, n));
}

// The Solco mark (src/app/icon.svg): a pulse/groove line on the night tile.
const MARK_SVG =
  '<svg class="mark" viewBox="0 0 32 32" width="40" height="40" aria-hidden="true" focusable="false">' +
  '<rect width="32" height="32" rx="9" fill="#08151F"/>' +
  '<path d="M6 17h4l2-6 4 12 3-9 2 3h5" fill="none" stroke="#C5ED72" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#08151F"/><path d="M6 17h4l2-6 4 12 3-9 2 3h5" fill="none" stroke="#C5ED72" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}`;

const COPY = {
  'first-visit': {
    eyebrow: '',
    headline: 'Stiamo preparando Solco…',
    smallPrint: 'Controllo di sicurezza al primo ingresso da questa rete: ci vuole un attimo.',
  },
  attack: {
    eyebrow: 'Traffico elevato',
    headline: 'Stiamo preparando Solco…',
    smallPrint: 'Tanto traffico in questo momento: verifichiamo che tu sia una persona.',
  },
} as const satisfies Record<UamPageMode, { eyebrow: string; headline: string; smallPrint: string }>;

const STYLE = `
:root {
  color-scheme: dark;
  --bg: #000000;
  --fg: #fafafa;
  --fg-soft: #d4d4d4;
  --muted: #a3a3a3;
  --faint: #8f8f8f;
  --track: #262626;
  --line: #2e2e2e;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
html { height: 100%; background: var(--bg); -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100%;
  min-height: 100vh;
  min-height: 100svh;
  display: grid;
  grid-template-rows: 1fr auto;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 16px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
.groove {
  position: fixed;
  top: 44%;
  left: 50%;
  width: min(150vmax, 1500px);
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background:
    radial-gradient(circle, rgb(255 255 255 / 0.07) 0, transparent 34%),
    repeating-radial-gradient(circle, rgb(255 255 255 / 0.055) 0 1px, transparent 1px 9px);
  -webkit-mask-image: radial-gradient(circle, #000 0, rgb(0 0 0 / 0.55) 30%, transparent 64%);
  mask-image: radial-gradient(circle, #000 0, rgb(0 0 0 / 0.55) 30%, transparent 64%);
  pointer-events: none;
  z-index: 0;
}
.groove::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0deg, rgb(255 255 255 / 0.06) 24deg, transparent 58deg, transparent 180deg, rgb(255 255 255 / 0.06) 204deg, transparent 238deg);
  animation: spin 14s linear infinite;
}
main {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  padding: 48px 24px 24px;
}
.panel {
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.lockup {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 40px;
}
.mark { display: block; width: 40px; height: 40px; border-radius: 11px; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08), 0 10px 28px rgb(197 237 114 / 0.08); }
.wordmark { font-size: 28px; font-weight: 700; letter-spacing: -0.045em; line-height: 1; }
.eq {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 48px;
  margin: 0 0 28px;
}
.eq span {
  display: block;
  width: 6px;
  height: 48px;
  border-radius: 3px;
  background: var(--fg);
  transform-origin: 50% 50%;
  animation: eq 1.1s ease-in-out infinite;
  will-change: transform;
}
/* Static heights (no-JS / reduced motion); the running animation overrides them. */
.eq span:nth-child(1) { transform: scaleY(0.45); animation-duration: 1.05s; animation-delay: -0.42s; }
.eq span:nth-child(2) { transform: scaleY(0.8); animation-duration: 0.9s; animation-delay: -0.18s; }
.eq span:nth-child(3) { transform: scaleY(1); animation-duration: 1.2s; animation-delay: -0.66s; }
.eq span:nth-child(4) { transform: scaleY(0.62); animation-duration: 0.95s; animation-delay: -0.3s; }
.eq span:nth-child(5) { transform: scaleY(0.38); animation-duration: 1.12s; animation-delay: -0.84s; }
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 14px;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgb(255 255 255 / 0.04);
  color: var(--fg-soft);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.eyebrow::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--fg); }
h1 {
  margin: 0;
  font-size: clamp(24px, 6.4vw, 32px);
  font-weight: 650;
  letter-spacing: -0.035em;
  line-height: 1.15;
  text-wrap: balance;
}
.status {
  min-height: 3em;
  margin: 10px 0 0;
  color: var(--fg-soft);
  font-size: 15px;
  text-wrap: balance;
}
.slot { display: grid; width: 100%; max-width: 320px; margin: 8px 0 0; }
.slot > * { grid-area: 1 / 1; }
.progress { align-self: center; }
.bar {
  position: relative;
  width: 100%;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--track);
}
.fill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--fg);
  transform: scaleX(0);
  transform-origin: 0 50%;
  transition: transform 240ms ease-out;
}
.actions { display: flex; justify-content: center; visibility: hidden; }
button {
  min-height: 44px;
  padding: 0 24px;
  border: 0;
  border-radius: 999px;
  background: var(--fg);
  color: var(--bg);
  font: inherit;
  font-size: 15px;
  font-weight: 650;
  cursor: pointer;
}
button:hover { background: #ffffff; }
button:focus-visible { outline: 2px solid var(--fg); outline-offset: 3px; }
.small {
  max-width: 340px;
  margin: 28px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.55;
  text-wrap: balance;
}
noscript p {
  margin: 16px 0 0;
  padding: 10px 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  color: var(--fg);
  font-size: 15px;
}
footer {
  position: relative;
  z-index: 1;
  padding: 0 24px max(24px, env(safe-area-inset-bottom));
  color: var(--faint);
  font-size: 12px;
  letter-spacing: 0.04em;
  text-align: center;
}
footer p { margin: 0; }
[data-state="error"] .progress { visibility: hidden; }
[data-state="error"][data-retry="on"] .actions { visibility: visible; }
[data-state="error"] .eq span { animation-play-state: paused; opacity: 0.35; }
[data-state="done"] .eq span { animation-duration: 0.6s; }
@keyframes eq { 0%, 100% { transform: scaleY(0.28); } 50% { transform: scaleY(1); } }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 360px) {
  main { padding: 40px 16px 20px; }
  .lockup { margin-bottom: 32px; }
}
/* Where the headline can wrap, keep its 2-line box when an error title replaces
   it, so the centred panel does not jump (layout shift). */
@media (max-width: 374px) {
  h1 { min-height: 2.3em; }
}
@media (min-width: 768px) {
  .lockup { margin-bottom: 48px; }
}
@media (prefers-reduced-motion: reduce) {
  .groove::after { animation: none; }
  .eq span { animation: none; will-change: auto; }
  .fill { transition: none; }
}
`;

// Inline proof-of-work solver. ES2017, no libraries, no template literals.
const SOLVER = `(function () {
  'use strict';
  var TRIES_KEY = '${UAM_TRIES_KEY}';
  var VERIFY_PATH = '${UAM_VERIFY_PATH}';
  var VERIFY_TIMEOUT_MS = ${UAM_VERIFY_TIMEOUT_MS};
  var TRY_WINDOW_MS = 120000;
  var MAX_RELOADS = 3;
  var STALE_WINDOW_MS = 600000;
  var MAX_STALE = 2;
  var BATCH = 256;
  var MIN_VISIBLE_MS = 600;
  var TITLE_STUCK = 'Controllo non completato';
  var TITLE_BROWSER = 'Browser non supportato';
  var MSG_COOKIES = 'Non riusciamo a completare il controllo. Attiva i cookie e riprova.';
  var MSG_SLOW = 'Il controllo sta richiedendo troppo tempo su questo dispositivo o rete. Riprova.';
  var MSG_BROWSER = 'Aggiorna il browser per entrare in Solco.';
  var MSG_GENERIC = 'Qualcosa non ha funzionato. Riprova tra un attimo.';
  var startedAt = Date.now();

  var root = document.documentElement;
  var titleEl = document.getElementById('uam-title');
  var statusEl = document.getElementById('uam-status');
  var barEl = document.getElementById('uam-progress');
  var fillEl = document.getElementById('uam-fill');
  var retryEl = document.getElementById('uam-retry');

  function setStatus(text) { if (statusEl) statusEl.textContent = text; }
  function setProgress(ratio) {
    var r = Math.max(0, Math.min(1, ratio));
    if (fillEl) fillEl.style.transform = 'scaleX(' + r.toFixed(4) + ')';
    if (barEl) barEl.setAttribute('aria-valuenow', String(Math.round(r * 100)));
  }
  function storage() { try { return sessionStorage; } catch (e) { return null; } }
  function reload() { location.reload(); }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function fail(title, message, canRetry) {
    root.setAttribute('data-retry', canRetry ? 'on' : 'off');
    root.setAttribute('data-state', 'error');
    if (titleEl) titleEl.textContent = title;
    setStatus(message);
    if (canRetry && retryEl) retryEl.focus();
  }

  function within(t, now, windowMs) {
    return typeof t === 'number' && now - t >= 0 && now - t < windowMs;
  }
  function saveTries(tries) {
    var store = storage();
    if (!store) return;
    var record = { n: tries.n, t: tries.t };
    if (tries.x > 0) { record.x = tries.x; record.xt = tries.xt; }
    try { store.setItem(TRIES_KEY, JSON.stringify(record)); } catch (e) { /* storage blocked */ }
  }

  // Reload-loop guard. n/t: views of this screen in this tab within 2 minutes of
  // the first one. x/xt: reloads for a stale challenge (400 expired/invalid),
  // kept for 10 minutes after the last one, because a slow solve can stretch
  // each cycle past the 2-minute window and would otherwise loop forever.
  function countTry() {
    var now = Date.now();
    var tries = { n: 1, t: now, x: 0, xt: 0 };
    var store = storage();
    if (!store) return tries;
    var record = null;
    try { record = JSON.parse(store.getItem(TRIES_KEY) || 'null'); } catch (e) { record = null; }
    if (record && typeof record === 'object') {
      if (typeof record.n === 'number' && within(record.t, now, TRY_WINDOW_MS)) {
        tries.n = record.n + 1;
        tries.t = record.t;
      }
      if (typeof record.x === 'number' && within(record.xt, now, STALE_WINDOW_MS)) {
        tries.x = record.x;
        tries.xt = record.xt;
      }
    }
    saveTries(tries);
    return tries;
  }

  if (retryEl) {
    retryEl.addEventListener('click', function () {
      var store = storage();
      try { if (store) store.removeItem(TRIES_KEY); } catch (e) { /* storage blocked */ }
      reload();
    });
  }

  function leadingZeroBits(bytes) {
    var bits = 0;
    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) { bits += 8; continue; }
      bits += Math.clz32(bytes[i]) - 24;
      break;
    }
    return bits;
  }

  async function solve(subtle, challenge, difficulty) {
    var encoder = new TextEncoder();
    var expected = Math.pow(2, difficulty);
    var limit = Math.min(999999999999, expected * 64);
    var lastYield = Date.now();
    for (var start = 0; start < limit; start += BATCH) {
      // Hand the main thread back now and then (paint, input, load event).
      if (Date.now() - lastYield > 50) {
        await wait(0);
        lastYield = Date.now();
      }
      var jobs = [];
      for (var i = 0; i < BATCH; i++) {
        jobs.push(subtle.digest('SHA-256', encoder.encode(challenge + ':' + (start + i))));
      }
      var digests = await Promise.all(jobs);
      for (var j = 0; j < digests.length; j++) {
        if (leadingZeroBits(new Uint8Array(digests[j])) >= difficulty) return String(start + j);
      }
      setProgress(Math.min(0.95, 1 - Math.exp(-(start + BATCH) / expected)));
    }
    return null;
  }

  async function run() {
    var data = null;
    try {
      var dataEl = document.getElementById('uam-data');
      data = JSON.parse((dataEl && dataEl.textContent) || 'null');
    } catch (e) { data = null; }
    if (!data || typeof data.challenge !== 'string' || typeof data.difficulty !== 'number' ||
        data.difficulty % 1 !== 0 || data.difficulty < 1 || data.difficulty > 32) {
      fail(TITLE_STUCK, MSG_GENERIC, true);
      return;
    }

    var tries = countTry();
    if (tries.x >= MAX_STALE) {
      fail(TITLE_STUCK, MSG_SLOW, true);
      return;
    }
    if (tries.n > MAX_RELOADS ||
        (typeof navigator !== 'undefined' && navigator && navigator.cookieEnabled === false)) {
      fail(TITLE_STUCK, MSG_COOKIES, true);
      return;
    }

    var subtle = (typeof crypto !== 'undefined' && crypto && crypto.subtle) || null;
    if (!subtle || typeof subtle.digest !== 'function' || typeof TextEncoder !== 'function') {
      fail(TITLE_BROWSER, MSG_BROWSER, false);
      return;
    }

    root.setAttribute('data-state', 'working');
    var solution = await solve(subtle, data.challenge, data.difficulty);
    if (solution === null) { fail(TITLE_STUCK, MSG_GENERIC, true); return; }

    setProgress(0.95);
    setStatus('Ancora un istante…');
    // A stalled request (dropped mobile link, hung function) must not leave the
    // screen at 95% forever: give up after VERIFY_TIMEOUT_MS. The race also
    // covers browsers without AbortController; where it exists, abort the request.
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = 0;
    var deadline = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* ignore */ } }
        reject(new Error('timeout'));
      }, VERIFY_TIMEOUT_MS);
    });
    var response;
    var payload = null;
    try {
      response = await Promise.race([
        fetch(VERIFY_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge: data.challenge, solution: solution }),
          signal: ctrl ? ctrl.signal : undefined
        }),
        deadline
      ]);
      if (!response.ok) {
        try { payload = await Promise.race([response.json(), deadline]); } catch (e) { payload = null; }
      }
    } catch (e) {
      fail(TITLE_STUCK, MSG_GENERIC, true);
      return;
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      // Cleared: the next stale challenge starts a fresh count.
      if (tries.x > 0) { tries.x = 0; saveTries(tries); }
      root.setAttribute('data-state', 'done');
      setProgress(1);
      setStatus('Fatto! Entriamo…');
      var elapsed = Date.now() - startedAt;
      if (elapsed < MIN_VISIBLE_MS) await wait(MIN_VISIBLE_MS - elapsed);
      reload();
      return;
    }

    var code = payload && typeof payload.error === 'string' ? payload.error : '';
    // A stale or foreign challenge: reload for a fresh one (the guard counts it).
    if (response.status === 400 && (code === 'expired' || code === 'invalid')) {
      tries.x += 1;
      tries.xt = Date.now();
      saveTries(tries);
      reload();
      return;
    }
    // The gate was switched off meanwhile: the page itself is reachable again.
    if (response.status === 503 && code === 'disabled') { reload(); return; }
    fail(TITLE_STUCK, MSG_GENERIC, true);
  }

  run().catch(function () { fail(TITLE_STUCK, MSG_GENERIC, true); });
})();`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Renders the complete interstitial HTML document (Italian copy, Solco brand). */
export function renderUamPage(input: UamPageInput): string {
  assertNonce(input.nonce);
  const mode: UamPageMode = input.mode === 'attack' ? 'attack' : 'first-visit';
  const copy = COPY[mode];
  const data = serializeUamData({
    challenge: String(input.challenge),
    difficulty: clampDifficulty(input.difficulty),
    mode,
  });
  const nonce = escapeHtml(input.nonce);
  const eyebrow = copy.eyebrow ? `<p class="eyebrow">${escapeHtml(copy.eyebrow)}</p>` : '';

  return `<!doctype html>
<html lang="it" data-state="idle" data-mode="${mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark">
<title>Solco</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">
<style>${STYLE}</style>
<noscript><style>.status, .slot { display: none; } .eq span { animation: none; }</style></noscript>
</head>
<body>
<div class="groove" aria-hidden="true"></div>
<main>
<div class="panel">
<div class="lockup">${MARK_SVG}<span class="wordmark">Solco</span></div>
<div class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
${eyebrow}<h1 id="uam-title">${escapeHtml(copy.headline)}</h1>
<p id="uam-status" class="status" role="status" aria-live="polite">Controllo in corso…</p>
<div class="slot">
<div class="progress"><div id="uam-progress" class="bar" role="progressbar" aria-label="Avanzamento del controllo" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="uam-fill" class="fill"></div></div></div>
<div class="actions"><button id="uam-retry" type="button">Riprova</button></div>
</div>
<noscript><p>Per entrare in Solco serve JavaScript.</p></noscript>
<p class="small">${escapeHtml(copy.smallPrint)}</p>
</div>
</main>
<footer><p>Ogni ascolto lascia un solco.</p></footer>
<script type="application/json" id="uam-data">${data}</script>
<script nonce="${nonce}">${SOLVER}</script>
</body>
</html>
`;
}
