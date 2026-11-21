// @polsia:user-owned — captures the real Solco screens for the TikTok ad, in a mobile browser at
// 1080 px wide (360×640 CSS px × 3), full page so the renderer can pan. Solco's anti-bot gate is
// passed with the same proof-of-work as the loading screen (workers/ai-agents/lib.mjs passGate),
// with the browser's own User-Agent, so the clearance cookie is valid for this browser.
// Usage: node tools/tiktok-ad/capture.mjs <outDir>
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import process from 'node:process';
import { chromium } from 'playwright';
import { passGate, SOLCO_ORIGIN } from '../../workers/ai-agents/lib.mjs';

const out = process.argv[2] ?? 'tiktok-ad-screens';
mkdirSync(out, { recursive: true });
const SCREENS = ['/', '/radio', '/podcasts', '/generi', '/classici', '/search'];
const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

// Node's fetch does not use this machine's proxy: route the gate through curl (same egress as the browser).
const viaCurl = async (url, init = {}) => {
  const args = ['-s', '--compressed', '-m', '25', '-D', '-', '-X', init.method ?? 'GET'];
  for (const [k, v] of Object.entries(init.headers ?? {})) args.push('-H', `${k}: ${v}`);
  if (init.body) args.push('--data-binary', init.body);
  args.push(url);
  let raw = execFileSync('curl', args, { maxBuffer: 30e6 }).toString('utf8');
  while (/^HTTP\/1\.1 200 Connection Established/i.test(raw)) raw = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  const i = raw.indexOf('\r\n\r\n');
  const [status, ...lines] = raw.slice(0, i).split('\r\n');
  const headers = new Headers();
  for (const l of lines) {
    const j = l.indexOf(':');
    if (j > 0) headers.append(l.slice(0, j).trim(), l.slice(j + 1).trim());
  }
  return new Response(raw.slice(i + 4), { status: Number(status.split(' ')[1]) || 200, headers });
};
const fetchImpl = process.env.HTTPS_PROXY ? viaCurl : fetch;

const gate = await passGate(SOLCO_ORIGIN, fetchImpl, UA);
console.log('gate:', gate.cookie ? `passed (${gate.gateMs} ms)` : `no cookie (${gate.reason})`);

// CHROMIUM_PATH: a browser already on the machine (e.g. /opt/pw-browsers/chromium) when the project's
// Playwright version has none of its own installed.
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
});
const context = await browser.newContext({
  viewport: { width: 360, height: 640 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: UA,
  locale: 'it-IT',
  colorScheme: 'dark',
});
if (gate.cookie) {
  const [name, value] = gate.cookie.split(';')[0].split('=');
  await context.addCookies([{ name, value, domain: 'www.solcomusic.online', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
}
const page = await context.newPage();
for (const path of SCREENS) {
  const res = await page.goto(new URL(path, SOLCO_ORIGIN).href, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => null);
  await page.waitForTimeout(1500); // fonts, lazy content
  const gated = (await res?.headerValue('x-solco-gate')) === 'challenge';
  const name = path === '/' ? 'home' : path.slice(1);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log(`${path}: ${res?.status() ?? 'error'} ${gated ? 'GATE PAGE (not the real page)' : 'ok'} height=${height * 3}px → ${out}/${name}.png`);
}
await browser.close();
