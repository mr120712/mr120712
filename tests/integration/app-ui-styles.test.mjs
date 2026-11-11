import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Run with `node --test tests/integration/app-ui-styles.test.mjs` (needs Chrome or CHROME_BIN;
// not part of `npm test`). Renders the real components without importing AppSurface, compiles
// the real globals.css → custom-style.css → app-ui.css chain, and checks the cascade in Chrome.
// Adapted from PR #74 (kyr0de): the composition stylesheet is imported from the user-owned
// custom-style.css, so the "without compositions" variant drops that import line.
const root = fileURLToPath(new URL('../../', import.meta.url));
const chrome =
  process.env.CHROME_BIN ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync);

// `--dump-dom` prints the document and, on some Chrome builds (153 on macOS), the process
// then lingers instead of exiting. Resolve on the dump and kill the browser ourselves.
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
        '--window-size=1440,900',
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

async function renderStandaloneCompositions() {
  assert.ok(chrome, 'Install Chrome/Chromium or set CHROME_BIN to run the composition CSS tests');
  const cache = path.join(root, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const fixture = mkdtempSync(path.join(cache, 'app-ui-styles-'));
  try {
    const modules = new Map();
    async function compileModule(name) {
      if (modules.has(name)) return modules.get(name);
      const sourceFile = ['.tsx', '.ts']
        .map((extension) => path.join(root, `src/${name}${extension}`))
        .find(existsSync);
      assert.ok(sourceFile, `Component dependency ${name} must exist`);
      const source = readFileSync(sourceFile, 'utf8');
      const result = ts.transpileModule(source, {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      });
      const output = path.join(fixture, `${name}.mjs`);
      modules.set(name, output);
      let javascript = result.outputText;
      for (const match of result.outputText.matchAll(/from (["'])(@\/[^"']+)\1/g)) {
        const dependency = await compileModule(match[2].slice(2));
        javascript = javascript.replace(
          match[0],
          `from ${JSON.stringify(pathToFileURL(dependency).href)}`,
        );
      }
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, javascript);
      return output;
    }
    const component = async (name) =>
      import(pathToFileURL(await compileModule(`components/custom/app-ui/${name}`)).href);
    const { PageHeader } = await component('page-header');
    const { MetricCard, MetricGrid } = await component('metrics');
    const { Panel } = await component('panel');
    const { StatusBadge } = await component('status-badge');
    const { DataTable } = await component('data-table');
    const table = createElement(DataTable, {
      label: 'Team work',
      rows: [{ id: 'one', count: 3 }],
      rowKey: (row) => row.id,
      columns: [
        { id: 'name', header: 'Name', cell: () => 'Project' },
        { id: 'count', header: 'Count', cell: (row) => row.count, align: 'right' },
      ],
    });
    const defaults = renderToStaticMarkup(
      createElement(
        'div',
        { className: 'app-ui', id: 'surface' },
        createElement(PageHeader, { title: 'Workspace', description: 'Your team at a glance.' }),
        createElement(
          MetricGrid,
          { label: 'Workspace metrics' },
          ...[12, 8, 3].map((value, index) =>
            createElement(MetricCard, { key: index, label: `Metric ${index + 1}`, value }),
          ),
        ),
        createElement(
          Panel,
          { title: 'Account', actions: createElement('button', { type: 'button' }, 'Options') },
          table,
        ),
        createElement(StatusBadge, { tone: 'positive' }, 'Active'),
      ),
    );
    const overrides = renderToStaticMarkup(
      createElement(
        'div',
        {
          id: 'custom-surface',
          className:
            'app-ui p-2 bg-[#112233] text-[#ffeecc] text-base [--app-gap:0.5rem] [&_.app-ui-metric]:p-1 [&_.app-ui-status]:text-[#112233] [&_.app-ui-status]:font-bold',
          'data-density': 'compact',
        },
        createElement('h2', { className: 'mt-2 text-2xl' }, 'Bon retour.'),
        createElement('p', { className: 'mt-6' }, 'Create an account'),
        createElement(
          MetricGrid,
          { label: 'Custom metrics' },
          createElement(MetricCard, { label: 'Open', value: 3 }),
        ),
        createElement(
          Panel,
          { title: 'Custom panel', className: 'rounded-none shadow-lg bg-[#ddeeff] mt-1 p-2' },
          'Content',
        ),
        createElement(StatusBadge, { tone: 'positive' }, 'Custom status'),
      ),
    );
    const content = defaults + overrides;
    const rendered = path.join(fixture, 'rendered.html');
    // Scan the actual class names; React's HTML escaping is decoded by the browser.
    writeFileSync(rendered, content.replaceAll('&amp;', '&'));
    // Compile the real chain (globals.css → custom-style.css → app-ui.css) from a fixture app
    // dir so the user-owned custom-style.css can be varied; the app-ui import is rewritten to
    // an absolute path because the fixture lives outside src/.
    const app = path.join(fixture, 'app');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      path.join(app, 'brand-theme.css'),
      readFileSync(path.join(root, 'src/app/brand-theme.css'), 'utf8'),
    );
    const custom = readFileSync(path.join(root, 'src/app/custom-style.css'), 'utf8');
    const importLine = /@import ["'][^"']*\/app-ui\.css["'](?:\s+layer\([^)]*\))?;\s*/;
    assert.match(custom, importLine, 'custom-style.css must import the composition stylesheet');
    const appUiPath = path.join(root, 'src/components/custom/app-ui/app-ui.css');
    const withImport = custom.replace(importLine, (line) =>
      line.replace(/["'][^"']*\/app-ui\.css["']/, JSON.stringify(appUiPath)),
    );
    const globals = readFileSync(path.join(root, 'src/app/globals.css'), 'utf8').replace(
      '@import "tailwindcss";',
      '@import "tailwindcss" source(none);',
    );
    const compile = async (customCss) => {
      writeFileSync(path.join(app, 'custom-style.css'), customCss);
      const source = `${globals}
      @source ${JSON.stringify(rendered)};
      @source inline("bg-background text-foreground font-body text-h1 bg-primary text-primary-foreground rounded-md p-block");`;
      return (
        await postcss([tailwind({ base: root })]).process(source, {
          from: path.join(app, 'globals.css'),
        })
      ).css;
    };
    const css = await compile(withImport);
    // Without the composition stylesheet, pages that do not use the blocks must be identical.
    const withoutCompositions = await compile(custom.replace(importLine, ''));
    writeFileSync(
      path.join(fixture, 'index.html'),
      `<!doctype html><html><head><style id="compiled">${css}</style>
      <style>* { transition: none !important; animation: none !important; }</style></head>
      <body>${content}
      <section id="legacy" class="bg-background text-foreground font-body">
        <h1 class="text-h1">Existing page</h1>
        <button class="bg-primary text-primary-foreground rounded-md p-block">Continue</button>
      </section>
      <pre id="result"></pre><script>
      function legacy() {
        return [...document.querySelectorAll('#legacy, #legacy *')].map(element => {
          const style = getComputedStyle(element);
          return Object.fromEntries(['display', 'backgroundColor', 'color', 'fontFamily',
            'fontSize', 'fontWeight', 'lineHeight', 'marginTop', 'marginBottom',
            'paddingTop', 'paddingRight', 'borderRadius'].map(key => [key, style[key]]));
        });
      }
      const output = { legacy: {} };
      for (const mode of ['light', 'dark']) {
        document.documentElement.classList.toggle('dark', mode === 'dark');
        output.legacy[mode] = { withCompositions: legacy() };
      }
      document.documentElement.classList.remove('dark');
      const header = document.querySelector('.app-ui-page-header');
      const heading = header.querySelector('h1');
      const grid = document.querySelector('.app-ui-metrics');
      const cards = [...grid.children];
      output.composition = {
        headerDisplay: getComputedStyle(header).display,
        headerMarginBottom: getComputedStyle(header).marginBottom,
        headingSize: getComputedStyle(heading).fontSize,
        headingWeight: getComputedStyle(heading).fontWeight,
        surfaceFontSize: getComputedStyle(document.getElementById('surface')).fontSize,
        gridDisplay: getComputedStyle(grid).display,
        gridGap: getComputedStyle(grid).gap,
        gridColumns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(track => parseFloat(track) > 0).length,
        cardPadding: cards.map(card => getComputedStyle(card).paddingTop),
        cardTops: cards.map(card => card.getBoundingClientRect().top),
        cardLefts: cards.map(card => card.getBoundingClientRect().left),
      };
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      const hasVisibleShadow = (selector) => {
        const shadow = style(selector).boxShadow;
        const colors = shadow.match(/(?:rgba?|oklab|oklch|color|lab|lch|hsla?)[(][^)]*[)]/g) || [];
        return shadow !== 'none' && (colors.length === 0 || colors.some(color => color !== 'rgba(0, 0, 0, 0)'));
      };
      output.defaults = {};
      for (const mode of ['light', 'dark']) {
        document.documentElement.classList.toggle('dark', mode === 'dark');
        output.defaults[mode] = {};
        for (const density of ['comfortable', 'compact']) {
          document.getElementById('surface').dataset.density = density;
          output.defaults[mode][density] = {
            panelRadius: style('#surface .app-ui-panel').borderRadius,
            panelHasShadow: hasVisibleShadow('#surface .app-ui-panel'),
            headerDirection: style('#surface .app-ui-panel-header').flexDirection,
            headerPadding: style('#surface .app-ui-panel-header').paddingTop,
            headPadding: style('#surface th').paddingLeft,
            cellPadding: style('#surface td').paddingTop,
            headAlign: style('#surface th:last-child').textAlign,
            cellAlign: style('#surface td:last-child').textAlign,
            badgeWeight: style('#surface .app-ui-status').fontWeight,
            badgeColor: style('#surface .app-ui-status').color,
          };
        }
      }
      output.overrides = {
        headingSize: style('#custom-surface h2').fontSize,
        headingMargin: style('#custom-surface h2').marginTop,
        footerMargin: style('#custom-surface p').marginTop,
        surfaceSize: style('#custom-surface').fontSize,
        surfaceBackground: style('#custom-surface').backgroundColor,
        surfaceColor: style('#custom-surface').color,
        gridMargin: style('#custom-surface .app-ui-metrics').marginTop,
        metricPadding: style('#custom-surface .app-ui-metric').paddingTop,
        panelRadius: style('#custom-surface .app-ui-panel').borderRadius,
        panelHasShadow: hasVisibleShadow('#custom-surface .app-ui-panel'),
        panelBackground: style('#custom-surface .app-ui-panel').backgroundColor,
        panelMargin: style('#custom-surface .app-ui-panel').marginTop,
        panelPadding: style('#custom-surface .app-ui-panel').paddingTop,
        badgeColor: style('#custom-surface .app-ui-status').color,
        badgeWeight: style('#custom-surface .app-ui-status').fontWeight,
      };
      document.getElementById('compiled').textContent = ${JSON.stringify(withoutCompositions)};
      for (const mode of ['light', 'dark']) {
        document.documentElement.classList.toggle('dark', mode === 'dark');
        output.legacy[mode].withoutCompositions = legacy();
      }
      document.getElementById('result').textContent = JSON.stringify(output);
      </script></body></html>`,
    );
    const dom = await dumpDom(
      pathToFileURL(path.join(fixture, 'index.html')).href,
      path.join(fixture, 'chrome'),
    );
    const output = dom.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(output, 'Chrome must execute the composition and legacy computed-style probes');
    return JSON.parse(output);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test('standalone PageHeader and MetricGrid receive global styles under a manual app-ui root', async () => {
  const { composition } = await renderStandaloneCompositions();
  assert.equal(composition.gridDisplay, 'grid');
  assert.equal(composition.gridColumns, 3);
  assert.equal(new Set(composition.cardTops).size, 1);
  assert.ok(composition.cardLefts[0] < composition.cardLefts[1]);
  assert.ok(composition.cardLefts[1] < composition.cardLefts[2]);
  assert.equal(composition.gridGap, '1px');
  assert.deepEqual(composition.cardPadding, ['24px', '24px', '24px']);
  assert.equal(composition.headerDisplay, 'flex');
  assert.equal(composition.headerMarginBottom, '24px');
  assert.equal(composition.headingSize, '31.68px');
  assert.equal(composition.headingWeight, '650');
  assert.equal(composition.surfaceFontSize, '14px');
});

test('loading the composition stylesheet leaves pages without app-ui classes unchanged', async () => {
  const { legacy } = await renderStandaloneCompositions();
  for (const mode of ['light', 'dark']) {
    assert.deepEqual(legacy[mode].withCompositions, legacy[mode].withoutCompositions);
  }
});

test('explicit utilities override composition typography, spacing, density, radii and colors', async () => {
  const { overrides } = await renderStandaloneCompositions();
  assert.equal(overrides.headingSize, '24px');
  assert.equal(overrides.headingMargin, '8px');
  assert.equal(overrides.footerMargin, '24px');
  assert.equal(overrides.surfaceSize, '16px');
  assert.equal(overrides.surfaceBackground, 'rgb(17, 34, 51)');
  assert.equal(overrides.surfaceColor, 'rgb(255, 238, 204)');
  assert.equal(overrides.gridMargin, '8px');
  assert.equal(overrides.metricPadding, '4px');
  assert.equal(overrides.panelRadius, '0px');
  assert.equal(overrides.panelHasShadow, true);
  assert.equal(overrides.panelBackground, 'rgb(221, 238, 255)');
  assert.equal(overrides.panelMargin, '4px');
  assert.equal(overrides.panelPadding, '8px');
  assert.equal(overrides.badgeColor, 'rgb(17, 34, 51)');
  assert.equal(overrides.badgeWeight, '700');
});

test('composition wrappers preserve their default surfaces, status and table densities', async () => {
  const { defaults } = await renderStandaloneCompositions();
  for (const mode of ['light', 'dark']) {
    for (const density of ['comfortable', 'compact']) {
      assert.deepEqual(defaults[mode][density], {
        panelRadius: '10px',
        panelHasShadow: false,
        headerDirection: 'row',
        headerPadding: '24px',
        headPadding: density === 'compact' ? '10px' : '16px',
        cellPadding: density === 'compact' ? '10px' : '16px',
        headAlign: 'right',
        cellAlign: 'right',
        badgeWeight: '500',
        badgeColor: mode === 'dark' ? 'oklch(0.8 0.1 155)' : 'oklch(0.42 0.09 155)',
      });
    }
  }
});
