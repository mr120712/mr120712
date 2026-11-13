// @polsia:user-owned
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { LandingPage } from '@/components/custom/landing-page';

const roots: Array<ReturnType<typeof createRoot>> = [];
let container: HTMLDivElement;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<LandingPage />));
  return container;
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  container?.remove();
});

describe('LandingPage', () => {
  it('mostra un pulsante di accesso ben visibile verso /login', () => {
    render();
    const loginLinks = Array.from(container.querySelectorAll('a[href="/login"]'));
    expect(loginLinks.length).toBeGreaterThan(0);
    expect(loginLinks.some((a) => /accedi/i.test(a.textContent ?? ''))).toBe(true);
  });

  it('incorpora il video dell’app (muted, loop, inline)', () => {
    render();
    const video = container.querySelector('video');
    expect(video?.getAttribute('src')).toBe('/landing/intro.mp4');
    expect(video?.hasAttribute('loop')).toBe(true);
    expect(video?.getAttribute('poster')).toBe('/landing/intro-poster.jpg');
  });

  it('offre anche registrazione e link legali', () => {
    render();
    expect(container.querySelector('a[href="/signup"]')).toBeTruthy();
    expect(container.querySelector('a[href="/terms"]')).toBeTruthy();
    expect(container.querySelector('a[href="/privacy"]')).toBeTruthy();
  });
});
