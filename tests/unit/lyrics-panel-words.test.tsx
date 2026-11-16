// @polsia:user-owned — pannello "Testo" con i tempi delle parole (karaoke): nella riga corrente le
// parole già cantate, quella in corso e le successive hanno stati diversi; la lettura del tempo è
// più fitta (100 ms); le altre righe e le righe senza parole restano come prima; toccare una riga
// azzera la parola.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), loadLocalLyrics: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/local-music/lyrics', () => ({ loadLocalLyrics: mocks.loadLocalLyrics }));

import {
  LYRICS_POLL_MS,
  LYRICS_WORD_POLL_MS,
  LyricsPanel,
} from '@/components/custom/music/lyrics-panel';

const KARAOKE = {
  kind: 'synced' as const,
  lines: [
    {
      timeMs: 1000,
      text: 'Prima strofa cantata',
      words: [
        { timeMs: 1000, text: 'Prima' },
        { timeMs: 1500, text: 'strofa' },
        { timeMs: 2200, text: 'cantata' },
      ],
    },
    { timeMs: 4500, text: 'Seconda riga' },
  ],
  source: 'featured' as const,
  credit: null,
};

let root: Root | null = null;
let container: HTMLDivElement;
let now = 0;
const onSeek = vi.fn();

async function flush() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

async function render() {
  if (!root) root = createRoot(container);
  await act(async () =>
    root?.render(
      <LyricsPanel source="featured" id="Pop/A - B.mp3" getTime={() => now} onSeek={onSeek} />,
    ),
  );
  await flush();
}

function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function wordStates(lineIndex: number) {
  return [...container.querySelectorAll<HTMLElement>(`button[data-line="${lineIndex}"] span`)].map(
    (span) => span.dataset.state ?? null,
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  now = 0;
  onSeek.mockReset();
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockResolvedValue({ lyrics: KARAOKE });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('karaoke nel pannello del testo', () => {
  it('evidenzia la parola in corso della riga corrente e segue il tempo ogni 100 ms', async () => {
    await render();
    const first = container.querySelector<HTMLButtonElement>('button[data-line="0"]');
    expect(first?.textContent).toBe('Prima strofa cantata');
    // Prima della prima riga: nessuno stato sulle parole.
    expect(wordStates(0)).toEqual([null, null, null]);

    now = 1.2;
    tick(LYRICS_WORD_POLL_MS);
    expect(first?.getAttribute('aria-current')).toBe('true');
    expect(wordStates(0)).toEqual(['now', 'next', 'next']);

    now = 1.6;
    tick(LYRICS_WORD_POLL_MS);
    expect(wordStates(0)).toEqual(['sung', 'now', 'next']);

    now = 2.3;
    tick(LYRICS_WORD_POLL_MS);
    expect(wordStates(0)).toEqual(['sung', 'sung', 'now']);

    // Riga dopo, senza parole: la prima riga perde gli stati delle parole.
    now = 4.6;
    tick(LYRICS_WORD_POLL_MS);
    const second = container.querySelector<HTMLButtonElement>('button[data-line="1"]');
    expect(second?.getAttribute('aria-current')).toBe('true');
    expect(second?.querySelectorAll('span')).toHaveLength(0);
    expect(wordStates(0)).toEqual([null, null, null]);
    expect(LYRICS_WORD_POLL_MS).toBeLessThan(LYRICS_POLL_MS);
  });

  it('toccare una riga porta l’audio al suo tempo e riparte senza parola evidenziata', async () => {
    await render();
    now = 2.3;
    tick(LYRICS_WORD_POLL_MS);
    expect(wordStates(0)).toEqual(['sung', 'sung', 'now']);
    const first = container.querySelector<HTMLButtonElement>('button[data-line="0"]');
    await act(async () => {
      first?.click();
    });
    expect(onSeek).toHaveBeenCalledWith(1);
    expect(wordStates(0)).toEqual(['next', 'next', 'next']);
  });
});
