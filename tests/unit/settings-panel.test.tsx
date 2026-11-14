// @polsia:user-owned
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsPanel } from '@/components/custom/settings/settings-panel';
import { getAutoplay } from '@/lib/music/autoplay';
import { getDataSaver } from '@/lib/music/data-saver';

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<SettingsPanel />);
  });
  return container;
}

function switches(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[role="switch"]')];
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
});

describe('SettingsPanel', () => {
  it('mostra due interruttori, spenti di default', async () => {
    const container = await mount();
    const list = switches(container);
    expect(list).toHaveLength(2);
    for (const item of list) expect(item.getAttribute('aria-checked')).toBe('false');
  });

  it('accende Autoplay: lo store per dispositivo è aggiornato', async () => {
    const container = await mount();
    await act(async () => {
      switches(container)[0]?.click();
    });
    expect(getAutoplay()).toBe(true);
    expect(getDataSaver()).toBe(false);
  });

  it('accende Risparmio dati: lo store per dispositivo è aggiornato', async () => {
    const container = await mount();
    await act(async () => {
      switches(container)[1]?.click();
    });
    expect(getDataSaver()).toBe(true);
    expect(getAutoplay()).toBe(false);
  });

  it('riflette lo stato già salvato (acceso)', async () => {
    window.localStorage.setItem('solco:autoplay', '1');
    const container = await mount();
    expect(switches(container)[0]?.getAttribute('aria-checked')).toBe('true');
  });
});
