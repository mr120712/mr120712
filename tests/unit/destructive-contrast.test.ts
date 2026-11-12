// @polsia:user-owned — text on destructive buttons (e.g. "Smetti di condividere", "Elimina
// playlist"): text-destructive-foreground must resolve to a real color with AA contrast.
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const THEME = readFileSync(resolve(process.cwd(), 'src/app/brand-theme.css'), 'utf8');
const GLOBALS = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function block(css: string, selector: string) {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) return null;
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

function token(declarations: string | null, name: string) {
  const match = declarations?.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  return match?.[1] ?? null;
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

describe('testo dei pulsanti distruttivi', () => {
  it('text-destructive-foreground è un colore del tema', () => {
    expect(`${THEME}\n${GLOBALS}`).toMatch(
      /--color-destructive-foreground:\s*var\(--destructive-foreground\)/,
    );
  });

  it('ha un contrasto AA (4.5:1) in chiaro e in scuro', () => {
    for (const selector of [':root', '.dark']) {
      const rule = block(THEME, selector);
      const background = token(rule, '--destructive');
      const foreground = token(rule, '--destructive-foreground');
      expect(background, selector).not.toBeNull();
      expect(foreground, selector).not.toBeNull();
      expect(contrast(foreground as string, background as string), selector).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('ogni variante che cambia --destructive cambia anche il suo testo', () => {
    for (const match of THEME.matchAll(/\n([^\n{]+)\{([^}]*)\}/g)) {
      const [, selector, declarations = ''] = match;
      if (/--destructive:/.test(declarations)) {
        expect(declarations, selector).toMatch(/--destructive-foreground:/);
      }
    }
  });
});
