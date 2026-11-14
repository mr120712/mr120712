// @polsia:user-owned — "Rimuovi video": versione solo audio lecita se c'è, altrimenti il video se ne
// va e la sua musica si ferma (YouTube non consente audio senza video né in background).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: true,
  availability: 'yes' as 'unknown' | 'yes' | 'no',
  searching: false,
  start: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/components/custom/music/background-listen-button', () => ({
  useBackgroundListen: () => ({
    available: mocks.available,
    availability: mocks.availability,
    searching: mocks.searching,
    start: mocks.start,
  }),
}));

import {
  REMOVE_VIDEO_AUDIO_TEXT,
  REMOVE_VIDEO_ONLY_VIDEO_TEXT,
  REMOVE_VIDEO_SEARCH_ERROR_TEXT,
  RemoveVideoButton,
} from '@/components/custom/music/remove-video-button';

const video = { videoId: 'dQw4w9WgXcQ', title: 'Canzone Finta', channelTitle: 'Canale Finto' };
// Ogni test parte un minuto dopo il precedente: fuori dalla pausa anti doppio tocco.
let seq = 0;
const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount(onRemove: (videoId: string) => 'next' | 'stopped' | 'stale') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<RemoveVideoButton video={video} onRemoveWithoutAudio={onRemove} />),
  );
  const button = container.querySelector('button');
  if (!button) throw new Error('pulsante mancante');
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  seq += 1;
  vi.setSystemTime(Date.now() + 60_000 * seq);
  mocks.available = true;
  mocks.availability = 'yes';
  mocks.searching = false;
  mocks.start.mockReset();
  mocks.toast.mockReset();
  mocks.toast.success.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('Rimuovi video', () => {
  it('versione solo audio trovata: parte quella, il video non viene tolto a mano', async () => {
    mocks.start.mockResolvedValue({
      status: 'playing',
      track: { title: 'Canzone Finta', sourceLabel: 'Audius' },
    });
    const onRemove = vi.fn(() => 'next' as const);
    const button = await mount(onRemove);
    expect(button.textContent).toContain('Rimuovi video');
    expect(button.getAttribute('aria-label')).toBe('Rimuovi video: Canzone Finta');
    await click(button);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(REMOVE_VIDEO_AUDIO_TEXT, {
      description: 'Canzone Finta · Audius',
    });
  });

  it('solo video: il video si toglie e si passa al brano successivo', async () => {
    mocks.start.mockResolvedValue({ status: 'not_found' });
    const onRemove = vi.fn(() => 'next' as const);
    await click(await mount(onRemove));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith('Video rimosso.', {
      description: `${REMOVE_VIDEO_ONLY_VIDEO_TEXT} Passo al brano successivo.`,
    });
  });

  it('ricerca fallita: niente audio di YouTube in sottofondo, il player si chiude se è l’ultimo', async () => {
    mocks.start.mockResolvedValue({ status: 'error' });
    const onRemove = vi.fn(() => 'stopped' as const);
    await click(await mount(onRemove));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith('Video rimosso.', {
      description: `${REMOVE_VIDEO_SEARCH_ERROR_TEXT} Player chiuso.`,
    });
  });

  it('nessun catalogo solo audio configurato: il video si toglie subito, senza ricerche', async () => {
    mocks.available = false;
    mocks.availability = 'no';
    const onRemove = vi.fn(() => 'next' as const);
    await click(await mount(onRemove));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('brano cambiato durante la ricerca: nessun salto, nessun messaggio', async () => {
    mocks.start.mockResolvedValue({ status: 'stale' });
    const onRemove = vi.fn(() => 'next' as const);
    await click(await mount(onRemove));
    expect(onRemove).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('il player segnala che il video non è più quello corrente: nessun messaggio', async () => {
    mocks.start.mockResolvedValue({ status: 'not_found' });
    const onRemove = vi.fn((_videoId: string) => 'stale' as const);
    await click(await mount(onRemove));
    expect(onRemove).toHaveBeenCalledWith('dQw4w9WgXcQ');
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('controllo dei cataloghi non ancora concluso: si cerca comunque, non si rimuove alla cieca', async () => {
    mocks.available = false;
    mocks.availability = 'unknown';
    mocks.start.mockResolvedValue({
      status: 'playing',
      track: { title: 'Canzone Finta', sourceLabel: 'Jamendo' },
    });
    const onRemove = vi.fn(() => 'next' as const);
    await click(await mount(onRemove));
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('"Ascolta in background" sta già cercando: ci si aggancia e il video si toglie comunque', async () => {
    mocks.searching = true;
    mocks.start.mockResolvedValue({ status: 'not_found' });
    const onRemove = vi.fn(() => 'next' as const);
    const button = await mount(onRemove);
    expect(button.textContent).toContain('Cerco la versione audio');
    expect(button.getAttribute('aria-label')).toBe('Cerco la versione audio…: Canzone Finta');
    expect(button.getAttribute('aria-busy')).toBe('true');
    await click(button);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('doppio tocco: una sola ricerca gestita; subito dopo una rimozione il tocco si ignora', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.start.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const onRemove = vi.fn(() => 'next' as const);
    const button = await mount(onRemove);
    await click(button);
    await click(button);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ status: 'not_found' });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
    // Il tocco successivo arriva subito dopo la rimozione: colpirebbe il video seguente.
    mocks.availability = 'no';
    await click(button);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
