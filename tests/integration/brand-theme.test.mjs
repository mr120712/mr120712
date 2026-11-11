import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';

// Cascade contract between src/app/globals.css (layered fallback) and the user-owned
// src/app/brand-theme.css (unlayered overrides). Adapted from PR #74 (kyr0de).
//
// Run with `node --test tests/integration/brand-theme.test.mjs`. Not part of `npm test`
// or CI: a real browser is necessary because jsdom does not implement cascade layers.
// CHROME_BIN may point to Chrome/Chromium on machines without a standard install.
const root = fileURLToPath(new URL('../../', import.meta.url));
const chrome =
  process.env.CHROME_BIN ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync);
const globals = readFileSync(path.join(root, 'src/app/globals.css'), 'utf8');
const roles = ['background', 'card', 'popover', 'primary', 'secondary', 'muted', 'accent'];

// `--dump-dom` prints the serialized document and, on some Chrome builds (153 on macOS),
// the process then lingers instead of exiting. Resolve as soon as the dump is complete
// and kill the browser ourselves rather than waiting on its exit.
function dumpDom(url, profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      chrome,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-extensions',
        '--disable-sync',
        `--user-data-dir=${profile}`,
        '--dump-dom',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let exited = false;
    let settled = false;
    // Settle once the dump is complete, then wait for the browser to be gone so the
    // next fixture never starts while this profile is still being written.
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exited) return fn();
      child.once('exit', fn);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error(`Chrome printed no DOM within 60s\n${stderr}`))),
      60000,
    );
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('</html>')) settle(() => resolve(stdout));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', () => {
      exited = true;
      settle(() => resolve(stdout));
    });
    child.on('error', (error) => {
      exited = true;
      settle(() => reject(error));
    });
  });
}

async function renderTheme({
  brand = readFileSync(path.join(root, 'src/app/brand-theme.css'), 'utf8'),
  // The fixture app dir cannot resolve the optional app-ui import's relative path; the
  // composition cascade has its own test (app-ui-styles.test.mjs), so drop the line here.
  custom = readFileSync(path.join(root, 'src/app/custom-style.css'), 'utf8').replace(
    /@import ["'][^"']*\/app-ui\.css["'](?:\s+layer\([^)]*\))?;\s*/,
    '',
  ),
  seed = globals,
} = {}) {
  assert.ok(chrome, 'Install Chrome/Chromium or set CHROME_BIN to run the theme cascade tests');
  const cache = path.join(root, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const fixture = mkdtempSync(path.join(cache, 'brand-theme-'));
  try {
    const app = path.join(fixture, 'app');
    mkdirSync(app);
    writeFileSync(path.join(app, 'brand-theme.css'), brand);
    writeFileSync(path.join(app, 'custom-style.css'), custom);
    const classes = roles
      .map((role) => `bg-${role}`)
      .concat([
        'text-foreground',
        'text-primary-foreground',
        'font-body',
        'font-display',
        'text-h1',
        'rounded-md',
        'rounded-lg',
        'p-block',
        'border',
        'border-border',
      ]);
    const result = await postcss([tailwind({ base: root })]).process(
      `${seed.replace('@import "tailwindcss";', '@import "tailwindcss" source(none);')}\n@source inline("${classes.join(' ')}");`,
      { from: path.join(app, 'globals.css') },
    );
    writeFileSync(
      path.join(fixture, 'index.html'),
      `<!doctype html><html><head>
      <style>${result.css}</style></head><body class="font-body text-foreground">
      ${roles.map((role) => `<div id="${role}" class="bg-${role}"></div>`).join('')}
      <button id="button" class="bg-primary text-primary-foreground rounded-md border border-border p-block">Continue</button>
      <h1 id="heading" class="font-display text-h1 rounded-lg">Account</h1>
      <pre id="result"></pre><script>
      const output = {};
      for (const mode of ['light', 'dark']) {
        document.documentElement.classList.toggle('dark', mode === 'dark');
        const style = (id) => getComputedStyle(document.getElementById(id));
        output[mode] = {
          surfaces: Object.fromEntries(${JSON.stringify(roles)}.map(role => [role, style(role).backgroundColor])),
          foreground: getComputedStyle(document.body).color,
          bodyFont: getComputedStyle(document.body).fontFamily,
          buttonText: style('button').color,
          border: style('button').borderTopColor,
          radius: style('button').borderTopLeftRadius,
          padding: style('button').paddingTop,
          headingFont: style('heading').fontFamily,
          headingSize: style('heading').fontSize,
          headingWeight: style('heading').fontWeight,
          headingRadius: style('heading').borderTopLeftRadius,
        };
      }
      document.getElementById('result').textContent = JSON.stringify(output);
      </script></body></html>`,
    );
    const dom = await dumpDom(
      `file://${path.join(fixture, 'index.html')}`,
      path.join(fixture, 'chrome'),
    );
    const output = dom.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(output, 'Chrome must execute the computed-style probe');
    return JSON.parse(output);
  } finally {
    // Best effort: Chrome's helper processes can still be flushing the profile.
    try {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // A leftover fixture under node_modules/.cache is harmless.
    }
  }
}

test('an empty brand theme renders the neutral, achromatic fallback in both modes', async () => {
  const actual = await renderTheme();
  // Chroma 0: every derived role is grey. The hue is present but powerless.
  assert.deepEqual(actual.light.surfaces, {
    background: 'oklch(0.99 0.004 250)',
    card: 'oklch(1 0.002 250)',
    popover: 'oklch(1 0.002 250)',
    primary: 'oklch(0.47 0 250)',
    secondary: 'oklch(0.96 0.006 250)',
    muted: 'oklch(0.96 0.006 250)',
    accent: 'oklch(0.96 0.006 250)',
  });
  assert.deepEqual(actual.dark.surfaces, {
    background: 'oklch(0.16 0.012 250)',
    card: 'oklch(0.2 0.014 250)',
    popover: 'oklch(0.2 0.014 250)',
    primary: 'oklch(0.67 0 250)',
    secondary: 'oklch(0.26 0.014 250)',
    muted: 'oklch(0.26 0.014 250)',
    accent: 'oklch(0.26 0.014 250)',
  });
  assert.equal(actual.light.foreground, 'oklch(0.18 0.01 250)');
  assert.equal(actual.dark.foreground, 'oklch(0.96 0.006 250)');
  for (const mode of ['light', 'dark']) {
    assert.equal(actual[mode].radius, '8px');
    assert.equal(actual[mode].headingRadius, '10px');
    assert.equal(actual[mode].padding, '24px');
    assert.equal(actual[mode].headingSize, '48.832px');
    assert.equal(actual[mode].headingWeight, '700');
    // No web font ships: the declared stack is the real one.
    assert.equal(actual[mode].bodyFont, 'ui-sans-serif, system-ui, sans-serif');
  }
});

test('seed edits inside the brand_tokens slot still recolor the fallback and resize primitives', async () => {
  const actual = await renderTheme({
    seed: globals
      .replace('--brand-h: 250;', '--brand-h: 140;')
      .replace('--brand-c: 0;', '--brand-c: 0.2;')
      .replace('--radius: 0.625rem;', '--radius: 1rem;'),
  });
  assert.equal(actual.light.surfaces.primary, 'oklch(0.47 0.2 140)');
  assert.equal(actual.dark.surfaces.primary, 'oklch(0.67 0.2 140)');
  assert.equal(actual.light.radius, '14px');
  assert.equal(actual.dark.headingRadius, '16px');
});

test('the user theme controls independent semantic surfaces and both color modes', async () => {
  const actual = await renderTheme({
    brand: `
    :root { --background: #fff1e0; --foreground: #112233; --card: #ffffff;
      --popover: #eeffee; --primary: #cc5500; --primary-foreground: #ffffff;
      --secondary: #ffddaa; --muted: #ddddee; --accent: #ffccdd; --border: #886644; }
    .dark { --background: #111111; --foreground: #eeeeee; --card: #222222;
      --popover: #333333; --primary: #ffaa22; --primary-foreground: #111111;
      --secondary: #443322; --muted: #333344; --accent: #442233; --border: #aa8866; }
  `,
  });
  assert.deepEqual(actual.light.surfaces, {
    background: 'rgb(255, 241, 224)',
    card: 'rgb(255, 255, 255)',
    popover: 'rgb(238, 255, 238)',
    primary: 'rgb(204, 85, 0)',
    secondary: 'rgb(255, 221, 170)',
    muted: 'rgb(221, 221, 238)',
    accent: 'rgb(255, 204, 221)',
  });
  assert.deepEqual(actual.dark.surfaces, {
    background: 'rgb(17, 17, 17)',
    card: 'rgb(34, 34, 34)',
    popover: 'rgb(51, 51, 51)',
    primary: 'rgb(255, 170, 34)',
    secondary: 'rgb(68, 51, 34)',
    muted: 'rgb(51, 51, 68)',
    accent: 'rgb(68, 34, 51)',
  });
  assert.equal(actual.light.foreground, 'rgb(17, 34, 51)');
  assert.equal(actual.dark.foreground, 'rgb(238, 238, 238)');
  assert.equal(actual.light.buttonText, 'rgb(255, 255, 255)');
  assert.equal(actual.dark.buttonText, 'rgb(17, 17, 17)');
  assert.equal(actual.light.border, 'rgb(136, 102, 68)');
  assert.equal(actual.dark.border, 'rgb(170, 136, 102)');
});

test('user typography, independent radii and density reach the generated utilities', async () => {
  const actual = await renderTheme({
    brand: `:root {
    --font-body: Georgia, serif; --font-display: monospace;
    --text-h1: 2rem; --text-h1--font-weight: 500;
    --radius: 1rem; --radius-md: 3px; --spacing-block: 0.5rem;
  }`,
  });
  for (const mode of ['light', 'dark']) {
    assert.equal(actual[mode].bodyFont, 'Georgia, serif');
    assert.equal(actual[mode].headingFont, 'monospace');
    assert.equal(actual[mode].headingSize, '32px');
    assert.equal(actual[mode].headingWeight, '500');
    assert.equal(actual[mode].radius, '3px');
    assert.equal(actual[mode].headingRadius, '16px');
    assert.equal(actual[mode].padding, '8px');
  }
});

test('the existing custom CSS entrypoint can override framework defaults too', async () => {
  const actual = await renderTheme({ custom: ':root { --primary: #990011; }' });
  assert.equal(actual.light.surfaces.primary, 'rgb(153, 0, 17)');
  assert.equal(actual.dark.surfaces.primary, 'rgb(153, 0, 17)');
});

test('user Tailwind theme declarations also override the seeded utility defaults', async () => {
  const actual = await renderTheme({
    brand: '@theme { --text-h1: 1.75rem; --spacing-block: 0.75rem; }',
  });
  assert.equal(actual.light.headingSize, '28px');
  assert.equal(actual.dark.padding, '12px');
});
