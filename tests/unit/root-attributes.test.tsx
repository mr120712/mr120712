// @polsia:user-owned
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The seam under test is swapped per case; the layout reads it at render time.
const seam = vi.hoisted(() => ({ htmlClassName: '', bodyClassName: '' }));
vi.mock('@/lib/root-attributes', () => ({
  get htmlClassName() {
    return seam.htmlClassName;
  },
  get bodyClassName() {
    return seam.bodyClassName;
  },
}));
// No request scope in a unit test: no nonce header, a public pathname for the nav.
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/pricing' }));
// jsdom has a window but no matchMedia; next-themes reads the color-scheme query on render.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  media: '',
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
}));
afterAll(() => vi.unstubAllGlobals());

const FRAMEWORK_BODY_CLASSES = [
  'min-h-screen',
  'bg-background',
  'font-body',
  'text-foreground',
  'antialiased',
];

async function renderShell() {
  const { default: RootLayout } = await import('@/app/layout');
  const tree = await RootLayout({ children: <main>Page content</main> });
  return new DOMParser().parseFromString(renderToStaticMarkup(tree), 'text/html');
}

describe('root attribute seam (src/lib/root-attributes.ts)', () => {
  it('renders the framework body classes and no html class when the seam is empty', async () => {
    seam.htmlClassName = '';
    seam.bodyClassName = '';
    const doc = await renderShell();
    expect(doc.documentElement.hasAttribute('class')).toBe(false);
    expect([...doc.body.classList]).toEqual(FRAMEWORK_BODY_CLASSES);
    expect(doc.querySelector('main')?.textContent).toBe('Page content');
  });

  it('merges htmlClassName and bodyClassName onto <html> and <body>', async () => {
    // The shape next/font `.variable` classes have once composed in the seam.
    seam.htmlClassName = '__variable_7c1e2a __variable_e9b1f0';
    seam.bodyClassName = 'density-compact';
    const doc = await renderShell();
    expect([...doc.documentElement.classList]).toEqual(['__variable_7c1e2a', '__variable_e9b1f0']);
    for (const cls of FRAMEWORK_BODY_CLASSES) {
      expect(doc.body.classList.contains(cls)).toBe(true);
    }
    expect(doc.body.classList.contains('density-compact')).toBe(true);
  });

  it('lets a body class from the seam win a Tailwind conflict through cn()', async () => {
    seam.htmlClassName = '';
    seam.bodyClassName = 'font-sans';
    const doc = await renderShell();
    // twMerge drops the framework's `font-body` when the seam sets another font-family utility.
    expect(doc.body.classList.contains('font-sans')).toBe(true);
    expect(doc.body.classList.contains('font-body')).toBe(false);
  });
});
