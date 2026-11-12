// @polsia:user-owned — /offline: Italian copy, no data fetching, readable as static HTML (no JS).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import OfflinePage, { metadata } from '@/app/(custom)/offline/page';

const PAGE_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/app/(custom)/offline/page.tsx'),
  'utf-8',
);

function renderPage(): Document {
  return new DOMParser().parseFromString(renderToStaticMarkup(<OfflinePage />), 'text/html');
}

describe('/offline page', () => {
  it('says the visitor is offline and what still works, in Italian', () => {
    const doc = renderPage();
    expect(doc.querySelector('h1')?.textContent).toBe('Sei offline');
    expect(doc.querySelector('h2')?.textContent).toBe('Cosa funziona ancora');
    const text = doc.body.textContent ?? '';
    expect(text).toContain('La tua musica');
    expect(text).toContain('in cima alla Libreria');
    expect(text).toContain('restano solo sul telefono');
  });

  it('offers a Riprova button and a link to the Library that works without JavaScript', () => {
    const doc = renderPage();
    const retry = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Riprova');
    expect(retry?.getAttribute('type')).toBe('button');
    const library = doc.querySelector<HTMLAnchorElement>('a[href="/library"]');
    expect(library?.textContent).toBe('Apri la Libreria');
    // Straight to the device-only section (the Service Worker serves the saved /library offline).
    const localMusic = doc.querySelector<HTMLAnchorElement>('a[href="/library#la-tua-musica"]');
    expect(localMusic?.textContent).toBe('La tua musica');
  });

  it('is not indexed and fetches no data', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(PAGE_SOURCE).not.toMatch(/apiFetch|fetch\(|useEffect|'use client'/);
  });
});
