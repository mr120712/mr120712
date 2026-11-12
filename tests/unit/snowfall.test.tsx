// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// La neve è un tema stagionale (src/lib/seasonal.ts): qui lo forziamo su "christmas"
// per provare il comportamento della neve, indipendentemente dall'impostazione live.
vi.mock('@/lib/seasonal', () => ({ seasonalTheme: 'christmas' }));

import { Snowfall, SnowToggle } from '@/components/custom/snowfall';

function stubMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', () => ({
    matches: reduce,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  window.matchMedia = globalThis.matchMedia;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
}

async function render(node: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, root };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('neve natalizia', () => {
  it('scende di default, si spegne dal pulsante ❄ e rispetta “riduci animazioni”', async () => {
    stubMotion(false);
    const { container, root } = await render(
      <>
        <SnowToggle />
        <Snowfall />
      </>,
    );
    expect(container.querySelector('canvas')).not.toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Ferma la neve"]');
    await act(async () => toggle?.click());
    expect(container.querySelector('canvas')).toBeNull();
    expect(window.localStorage.getItem('solco.snow')).toBe('off');
    await act(async () => root.unmount());

    window.localStorage.clear();
    stubMotion(true);
    const reduced = await render(<Snowfall />);
    expect(reduced.container.querySelector('canvas')).toBeNull();
    await act(async () => reduced.root.unmount());
  });
});
