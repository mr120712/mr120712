// @polsia:user-owned — punto d'ingresso di «Crea playlist» nella Libreria: in cima al modulo per
// creare una playlist c'è il pulsante principale «Crea playlist facile» che porta a /crea-playlist.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/library' }));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));

import { MusicCollections } from '@/components/custom/music/music-collections';
import { MusicPlayerProvider } from '@/components/custom/music/music-player';

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Libreria → Crea playlist facile', () => {
  it('mostra il pulsante principale prima del modulo per una playlist vuota', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path === '/api/music/collections' ? { collections: [] } : null,
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <MusicPlayerProvider>
          <MusicCollections embedded />
        </MusicPlayerProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const form = container.querySelector('form');
    expect(form?.textContent).toContain('Oppure crea una playlist vuota');
    const link = form?.querySelector<HTMLAnchorElement>('a[href="/crea-playlist"]');
    expect(link?.textContent).toContain('Crea playlist facile');
    // Il modo facile viene prima del campo del nome ed è l'azione principale (non «secondary»).
    const input = form?.querySelector('#playlist-name');
    expect(input).not.toBeNull();
    expect(
      link && input ? link.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING : 0,
    ).toBeTruthy();
    expect(link?.className).toContain('bg-primary');
    const plain = [...(form?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Crea playlist',
    );
    expect(plain?.className).not.toContain('bg-primary');
  });
});
