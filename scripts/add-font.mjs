#!/usr/bin/env node
// @polsia:framework-owned — DO NOT EDIT. Run it; don't change it.
//
// Self-hosts a Google Fonts family so the brand keeps the family it chose.
//
//   npm run font:add -- "Cormorant Garamond" 400 600 400italic
//   npm run font:add -- "Inter Tight" 300..800
//
// Downloads the latin + latin-ext .woff2 files into public/fonts/<slug>/ and
// writes the matching @font-face rules into src/app/custom-style.css between
// `font:add <Family>` markers (re-running replaces that block). The CSP already
// allows `font-src 'self'`; nothing is fetched from Google at build or runtime.
// Then point --font-display / --font-body in src/app/brand-theme.css at the family.
//
// If the download fails, fix the cause or supply the family's files yourself.
// Do not switch to a font that happens to be in the checkout: the files under
// public/landing/ are starter demo assets, not the customer's choice.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBSETS = ['latin', 'latin-ext'];
// A current desktop UA makes the CSS2 API answer with woff2 + unicode-range subsets.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export function slugify(family) {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** "400" | "400italic" | "300..700" | "300..700italic" -> { weight, italic } */
export function parseStyle(spec) {
  const match = /^(\d{3}(?:\.\.\d{3})?)(italic|i)?$/.exec(spec.trim());
  if (!match) throw new Error(`Unrecognized style "${spec}". Use 400, 400italic or 300..700.`);
  return { weight: match[1], italic: Boolean(match[2]) };
}

export function cssUrl(family, styles) {
  const tuples = [...new Map(styles.map((s) => [`${s.italic ? 1 : 0},${s.weight}`, s])).keys()]
    .sort()
    .join(';');
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css2?family=${name}:ital,wght@${tuples}&display=swap`;
}

/** Keeps the requested subsets from a CSS2 API response. */
export function parseFaces(css, subsets = SUBSETS) {
  const faces = [];
  const blocks = css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g);
  for (const [, subset, body] of blocks) {
    if (!subsets.includes(subset)) continue;
    const prop = (name) => new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1].trim();
    const url = /url\(([^)]+)\)\s*format\(['"]woff2['"]\)/.exec(body)?.[1];
    if (!url) continue;
    faces.push({
      subset,
      style: prop('font-style') ?? 'normal',
      weight: prop('font-weight') ?? '400',
      unicodeRange: prop('unicode-range'),
      url,
    });
  }
  return faces;
}

export function fileName(slug, face) {
  const weight = face.weight.replace(/\s+/g, '-');
  return `${slug}-${weight}-${face.style}-${face.subset}.woff2`;
}

export function fontFaceBlock(family, slug, faces) {
  const rules = faces.map((face) =>
    [
      '@font-face {',
      `  font-family: "${family}";`,
      `  font-style: ${face.style};`,
      `  font-weight: ${face.weight};`,
      '  font-display: swap;',
      `  src: url("/fonts/${slug}/${fileName(slug, face)}") format("woff2");`,
      ...(face.unicodeRange ? [`  unicode-range: ${face.unicodeRange};`] : []),
      '}',
    ].join('\n'),
  );
  return [`/* font:add ${family} — start */`, ...rules, `/* font:add ${family} — end */`].join(
    '\n',
  );
}

/** Inserts the block, or replaces the family's previous block in place. */
export function upsertBlock(css, family, block) {
  const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = new RegExp(
    `/\\* font:add ${escaped} — start \\*/[\\s\\S]*?/\\* font:add ${escaped} — end \\*/`,
  );
  if (existing.test(css)) return css.replace(existing, block);
  return `${css.replace(/\s*$/, '')}\n\n${block}\n`;
}

const log = (line) => process.stdout.write(`${line}\n`);
const fail = (line) => process.stderr.write(`${line}\n`);

async function download(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response;
}

async function main(argv) {
  const [family, ...specs] = argv;
  if (!family) {
    fail('Usage: npm run font:add -- "<Google Fonts family>" [400 600 400italic 300..700]');
    process.exit(2);
  }
  const styles = (specs.length ? specs : ['400']).map(parseStyle);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const slug = slugify(family);

  let faces;
  try {
    faces = parseFaces(await (await download(cssUrl(family, styles))).text());
  } catch (error) {
    fail(`Could not fetch "${family}" from Google Fonts: ${error.message}`);
    fail(
      'Check the exact family name and weights on fonts.google.com, or add its .woff2 files ' +
        'to public/fonts/ yourself. Keep the chosen family; do not substitute another one.',
    );
    process.exit(1);
  }
  if (!faces.length) {
    fail(`Google Fonts returned no latin woff2 files for "${family}".`);
    process.exit(1);
  }

  const dir = path.join(root, 'public/fonts', slug);
  await mkdir(dir, { recursive: true });
  for (const face of faces) {
    const bytes = Buffer.from(await (await download(face.url)).arrayBuffer());
    await writeFile(path.join(dir, fileName(slug, face)), bytes);
  }
  await writeFile(
    path.join(dir, 'SOURCE.md'),
    `# ${family}\n\nDownloaded from Google Fonts (${cssUrl(family, styles)}).\n` +
      'Check the family license on fonts.google.com before redistributing the files elsewhere.\n',
  );

  const cssPath = path.join(root, 'src/app/custom-style.css');
  const css = await readFile(cssPath, 'utf8');
  await writeFile(cssPath, upsertBlock(css, family, fontFaceBlock(family, slug, faces)));

  log(
    `Added ${faces.length} files to public/fonts/${slug}/ and @font-face rules to src/app/custom-style.css.`,
  );
  log(
    `Next: set --font-display or --font-body to "${family}", <fallback> in src/app/brand-theme.css.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
