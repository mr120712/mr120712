// @polsia:user-owned — pannello "Testo" del player: la riga corrente segue il tempo (finto)
// dell'audio, toccare una riga porta l'audio lì, lo scorrimento manuale ferma per ~3 s quello
// automatico, "riduci movimento" rende lo scorrimento istantaneo; stati di caricamento, testo
// assente, errore (Riprova), testo semplice e credito; nuova richiesta a ogni cambio di brano.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), loadLocalLyrics: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/local-music/lyrics', () => ({ loadLocalLyrics: mocks.loadLocalLyrics }));

import {
  LYRICS_MANUAL_SCROLL_PAUSE_MS,
  LYRICS_POLL_MS,
  LYRICS_UNAVAILABLE_MESSAGE,
  LyricsPanel,
  type LyricsPanelProps,
} from '@/components/custom/music/lyrics-panel';

const SYNCED = {
  kind: 'synced' as const,
  lines: [
    { timeMs: 1000, text: 'Prima riga' },
    { timeMs: 4500, text: 'Seconda riga' },
    { timeMs: 8000, text: '♪' },
    { timeMs: 9000, text: 'Terza riga' },
  ],
  source: 'featured' as const,
  credit: 'Testo: Autrice',
};

let root: Root | null = null;
let container: HTMLDivElement;
let now = 0;
let reducedMotion = false;
const scrollTo = vi.fn();
const onSeek = vi.fn();
const getTime = () => now;

async function flush() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

async function render(props: Partial<LyricsPanelProps> = {}) {
  const all: LyricsPanelProps = {
    source: 'featured',
    id: 'Pop/A - B.mp3',
    getTime,
    onSeek,
    ...props,
  };
  if (!root) root = createRoot(container);
  await act(async () => root?.render(<LyricsPanel {...all} />));
  await flush();
}

function lines() {
  return [...container.querySelectorAll<HTMLButtonElement>('button[data-line]')];
}
function current() {
  return container.querySelector<HTMLButtonElement>('button[aria-current="true"]');
}
function tick(ms = LYRICS_POLL_MS) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  now = 0;
  reducedMotion = false;
  scrollTo.mockReset();
  onSeek.mockReset();
  mocks.apiFetch.mockReset();
  mocks.loadLocalLyrics.mockReset();
  mocks.apiFetch.mockResolvedValue({ lyrics: SYNCED });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: scrollTo,
  });
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce') ? reducedMotion : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LyricsPanel: testo sincronizzato', () => {
  it('chiede il testo del brano e mostra le righe con il credito', async () => {
    await render();
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      `/api/music/lyrics?featured=${encodeURIComponent('Pop/A - B.mp3')}`,
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(lines().map((line) => line.textContent)).toEqual([
      'Prima riga',
      'Seconda riga',
      '♪',
      'Terza riga',
    ]);
    expect(container.textContent).toContain('Testo: Autrice');
    // La pausa strumentale ha un nome leggibile.
    expect(lines()[2]?.getAttribute('aria-label')).toBe('Pausa strumentale, vai a 0:08');
  });

  it('Premium: il pulsante «Condividi testo» appare solo per i Premium, a testo pronto', async () => {
    await render({ premium: true, trackTitle: 'Brano', trackArtist: 'Artista' });
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Condividi testo'),
    );
    expect(button).toBeTruthy();

    // Senza Premium: nessun pulsante di condivisione (il testo resta visibile).
    await render({ premium: false });
    expect(container.textContent).not.toContain('Condividi testo');
    expect(container.textContent).toContain('Prima riga');
  });

  it('la riga corrente (aria-current) segue il tempo dell’audio', async () => {
    await render();
    expect(current()).toBeNull();
    now = 1.2;
    tick();
    expect(current()?.textContent).toBe('Prima riga');
    now = 4.6;
    tick();
    expect(current()?.textContent).toBe('Seconda riga');
    expect(lines()[0]?.dataset.state).toBe('past');
    expect(lines()[3]?.dataset.state).toBe('future');
    // Nessuna regione live che annuncia le righe.
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('toccare una riga porta l’audio al suo tempo', async () => {
    await render();
    act(() => lines()[1]?.click());
    expect(onSeek).toHaveBeenCalledWith(4.5);
    expect(current()?.textContent).toBe('Seconda riga');
  });

  it('a pausa, dopo un tocco la riga resta quella toccata (niente errore di arrotondamento)', async () => {
    // 2010 / 1000 * 1000 = 2009,999…: senza arrotondare tornerebbe la riga precedente.
    mocks.apiFetch.mockResolvedValue({
      lyrics: {
        ...SYNCED,
        lines: [
          { timeMs: 1000, text: 'Prima' },
          { timeMs: 2010, text: 'Seconda' },
          { timeMs: 4020, text: 'Terza' },
        ],
      },
    });
    onSeek.mockImplementation((seconds: number) => {
      now = seconds;
    });
    await render();
    act(() => lines()[1]?.click());
    expect(onSeek).toHaveBeenCalledWith(2.01);
    expect(current()?.textContent).toBe('Seconda');
    tick();
    expect(current()?.textContent).toBe('Seconda');
    act(() => lines()[2]?.click());
    tick();
    expect(current()?.textContent).toBe('Terza');
  });

  it('la riga corrente va al centro; lo scorrimento manuale lo ferma per ~3 secondi', async () => {
    await render();
    now = 1.2;
    tick();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0]?.[0]).toMatchObject({ behavior: 'smooth' });

    const scroller = container.querySelector<HTMLElement>('[data-lyrics-scroller]');
    act(() => {
      scroller?.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    });
    now = 4.6;
    tick();
    expect(current()?.textContent).toBe('Seconda riga');
    expect(scrollTo).toHaveBeenCalledTimes(1);

    // Passati ~3 secondi si torna a seguire la riga corrente.
    tick(LYRICS_MANUAL_SCROLL_PAUSE_MS);
    expect(scrollTo).toHaveBeenCalledTimes(2);
    now = 9.1;
    tick();
    expect(scrollTo).toHaveBeenCalledTimes(3);
  });

  it('con "riduci movimento" lo scorrimento è istantaneo', async () => {
    reducedMotion = true;
    await render();
    now = 1.2;
    tick();
    expect(scrollTo.mock.calls[0]?.[0]).toMatchObject({ behavior: 'auto' });
  });

  it('frecce su/giù spostano il fuoco fra le righe (un solo tab stop)', async () => {
    await render();
    const [first, second] = lines();
    expect(lines().filter((line) => line.tabIndex === 0)).toHaveLength(1);
    act(() => first?.focus());
    act(() => {
      first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(second);
    expect(second?.tabIndex).toBe(0);
  });
});

describe('LyricsPanel: apertura con "Testo"', () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
  });

  it('aperto dall’ascoltatore: il pannello si porta in vista una volta sola', async () => {
    let pending = true;
    const consumeReveal = vi.fn(() => {
      const reveal = pending;
      pending = false;
      return reveal;
    });
    await render({ id: 'A.mp3', consumeReveal });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(container.querySelector('[data-lyrics-panel]'));
    expect(scrollIntoView.mock.calls[0]?.[0]).toEqual({ block: 'start', behavior: 'smooth' });
    // Cambio di brano col pannello aperto: nessun nuovo spostamento della pagina.
    await render({ id: 'B.mp3', consumeReveal });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('con "riduci movimento" è istantaneo; montato senza tocco (es. cambio brano) non si sposta', async () => {
    reducedMotion = true;
    await render({ consumeReveal: () => true });
    expect(scrollIntoView.mock.calls[0]?.[0]).toEqual({ block: 'start', behavior: 'auto' });

    act(() => root?.unmount());
    root = null;
    scrollIntoView.mockReset();
    await render({ consumeReveal: () => false });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('LyricsPanel: stati', () => {
  it('caricamento, poi "Testo non disponibile per questo brano"', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.apiFetch.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    expect(container.textContent).toContain('Caricamento del testo…');
    await act(async () => resolve({ lyrics: null }));
    await flush();
    expect(container.textContent).toContain(LYRICS_UNAVAILABLE_MESSAGE);
    expect(lines()).toHaveLength(0);
  });

  it('errore con "Riprova" che rifà la richiesta', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error('rete'));
    await render();
    expect(container.textContent).toContain('Non è stato possibile caricare il testo.');
    const retry = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Riprova'),
    );
    await act(async () => retry?.click());
    await flush();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(lines()).toHaveLength(4);
  });

  it('testo semplice: righe leggibili, strofe separate, nessun pulsante', async () => {
    mocks.apiFetch.mockResolvedValue({
      lyrics: {
        kind: 'plain',
        lines: [
          { timeMs: null, text: 'Uno' },
          { timeMs: null, text: '' },
          { timeMs: null, text: 'Due' },
        ],
        source: 'upload',
        credit: "Testo pubblicato dall'autore",
      },
    });
    await render({ source: 'upload', id: 'c'.repeat(25) });
    expect([...container.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Uno',
      'Due',
      "Testo pubblicato dall'autore",
    ]);
    expect(lines()).toHaveLength(0);
    now = 50;
    tick(1000);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('LyricsPanel: cambio di brano', () => {
  it('nuova richiesta a ogni brano; la precedente viene annullata', async () => {
    let firstSignal: AbortSignal | undefined;
    mocks.apiFetch.mockImplementationOnce((_path: string, init: { signal: AbortSignal }) => {
      firstSignal = init.signal;
      return new Promise(() => undefined);
    });
    await render({ id: 'A.mp3' });
    await render({ id: 'B.mp3' });
    expect(firstSignal?.aborted).toBe(true);
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      '/api/music/lyrics?featured=B.mp3',
      expect.anything(),
    );
    expect(lines()).toHaveLength(4);
  });

  it('stesse props: nessuna nuova richiesta (il pannello non si ridisegna col player)', async () => {
    await render();
    await render();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it('il fuoco su una riga passa all’area del testo (non a <body>) quando cambia brano', async () => {
    await render({ id: 'A.mp3' });
    act(() => lines()[1]?.focus());
    expect(document.activeElement).toBe(lines()[1]);
    mocks.apiFetch.mockReturnValueOnce(new Promise(() => undefined));
    await render({ id: 'B.mp3' });
    expect(lines()).toHaveLength(0);
    expect(document.activeElement).toBe(container.querySelector('[data-lyrics-scroller]'));
  });

  it('file del dispositivo: letto in locale, nessuna richiesta di rete', async () => {
    mocks.loadLocalLyrics.mockResolvedValue({ ...SYNCED, source: 'local', credit: 'Dal tuo file' });
    await render({ source: 'local', id: 'loc-1' });
    expect(mocks.loadLocalLyrics).toHaveBeenCalledWith('loc-1');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Dal tuo file');
  });
});
