// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({ currentTrack: null, status: 'idle', playTrack: vi.fn() }),
  trackStreamPath: () => null,
}));

import { JamendoSection } from '@/components/custom/music/jamendo-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.apiFetch.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('sezione Jamendo', () => {
  it('spenta (nessuna licenza commerciale) non mostra nulla, nemmeno durante il caricamento', async () => {
    let answer: (value: unknown) => void = () => {};
    mocks.apiFetch.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await act(async () => root.render(<JamendoSection />));
    expect(container.innerHTML).toBe('');
    await act(async () => answer({ outcome: 'not_configured', tracks: [] }));
    expect(container.innerHTML).toBe('');
    expect(container.textContent).not.toMatch(/Premium|Jamendo/);
  });

  it('se la richiesta fallisce (rete, 429, 5xx) non mostra nulla', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('429'));
    await act(async () => root.render(<JamendoSection />));
    expect(container.innerHTML).toBe('');
  });

  it('accesa mostra i brani con la licenza CC', async () => {
    mocks.apiFetch.mockResolvedValue({
      outcome: 'results',
      tracks: [
        {
          id: '1',
          title: 'Brano libero',
          artistName: 'Artista',
          albumName: null,
          artworkUrl: null,
          durationSeconds: 125,
          pageUrl: 'https://www.jamendo.com/track/1',
          licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
        },
      ],
    });
    await act(async () => root.render(<JamendoSection query="jazz" />));
    expect(container.textContent).toContain('Brano libero');
    expect(container.textContent).toContain('Licenza CC');
  });
});
