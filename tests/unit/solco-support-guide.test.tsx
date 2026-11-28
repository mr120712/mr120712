// L'agente di assistenza conosce la guida /guida attraverso un estratto di testo generato dai
// componenti della guida (una sola fonte). Questo test rigenera l'estratto e fallisce se il file
// committato è diverso: dopo aver cambiato la guida, aggiornalo con
//   UPDATE_SUPPORT_GUIDE=1 npx vitest run tests/unit/solco-support-guide.test.tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GuidePage } from '@/components/custom/guide/guide-page';
import { GUIDE_SECTIONS } from '@/components/custom/guide/guide-sections';

const GENERATED = resolve(process.cwd(), 'src/lib/business/solco-support-guide.generated.json');

const BLOCKS = new Set(['P', 'LI', 'SUMMARY', 'H2', 'H3', 'H4', 'DT', 'DD', 'TR', 'ASIDE']);

/** Testo leggibile di un nodo: un blocco per riga, elenchi con «-», link interni con la pagina. */
function nodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof HTMLElement)) return '';
  if (node.getAttribute('aria-hidden') === 'true') return '';
  const href = node.tagName === 'A' ? node.getAttribute('href') : null;
  let inner = Array.from(node.childNodes).map(nodeText).join('');
  if (href?.startsWith('#')) {
    // «Torna all'indice» non serve all'agente; gli altri salti puntano a una sezione della guida.
    if (inner.includes('Torna all’indice')) return '';
    inner = `${inner.trim()} (/guida${href})`;
  }
  if (href?.startsWith('/')) inner = `${inner.trim()} (${href})`;
  if (href?.startsWith('mailto:')) inner = inner.trim();
  // Un link fuori da una frase è un pulsante d'azione: una riga a sé.
  if (href && node.parentElement?.tagName === 'DIV') return `\n${inner}\n`;
  if (node.tagName === 'LI') return `\n- ${inner.trim()}\n`;
  if (node.tagName === 'SUMMARY') return `\nDomanda: ${inner.trim()}\n`;
  if (BLOCKS.has(node.tagName) || node.tagName === 'DIV' || node.tagName === 'SECTION') {
    return `\n${inner}\n`;
  }
  return inner;
}

function tidy(text: string) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function extractGuide() {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(<GuidePage />);
  return GUIDE_SECTIONS.map(({ id, title }) => {
    const section = root.querySelector(`section#${id}`);
    if (!section) throw new Error(`Sezione della guida non trovata: ${id}`);
    // Il titolo è già nell'intestazione della sezione per l'agente.
    section.querySelector('h2')?.remove();
    return { id, title, text: tidy(nodeText(section)) };
  });
}

/** JSON a 2 spazi con l'a capo finale: lo stesso formato che chiede Biome. */
function generatedSource(sections: ReturnType<typeof extractGuide>) {
  return `${JSON.stringify(sections, null, 2)}\n`;
}

describe('guida per l’agente di assistenza', () => {
  it('l’estratto committato corrisponde alla guida /guida', () => {
    const expected = generatedSource(extractGuide());
    if (process.env.UPDATE_SUPPORT_GUIDE === '1') writeFileSync(GENERATED, expected);
    expect(
      readFileSync(GENERATED, 'utf8'),
      'Guida cambiata: rigenera con UPDATE_SUPPORT_GUIDE=1 npx vitest run tests/unit/solco-support-guide.test.tsx',
    ).toBe(expected);
  });

  it('ogni sezione ha testo e i link interni restano leggibili', () => {
    const sections = extractGuide();
    expect(sections.map((section) => section.id)).toEqual(GUIDE_SECTIONS.map((s) => s.id));
    for (const section of sections) expect(section.text.length, section.id).toBeGreaterThan(40);
    const problems = sections.find((section) => section.id === 'problemi')?.text ?? '';
    expect(problems).toContain('Domanda: Non arriva l’email per cambiare la password');
    expect(problems).toContain('Impostazioni (/impostazioni)');
    expect(problems).not.toContain('Torna all’indice');
  });
});
