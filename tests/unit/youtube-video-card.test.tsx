// @polsia:user-owned
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { YouTubeVideoCard } from '@/components/custom/music/youtube-video-card';

const video = {
  provider: 'youtube' as const,
  videoId: 'dQw4w9WgXcQ',
  title: 'Video di esempio',
  channelTitle: 'Canale indicato da YouTube',
  channelId: 'UCsample123',
  description: 'Descrizione ufficiale.',
  publishedAt: '2024-02-03T12:00:00.000Z',
  thumbnailUrl: null,
};
const mountedRoots: Array<ReturnType<typeof createRoot>> = [];
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');

async function mount(selected = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  mountedRoots.push(root);
  function Harness() {
    const [isSelected, setIsSelected] = useState(selected);
    return (
      <YouTubeVideoCard
        video={video}
        selected={isSelected}
        onSelect={() => setIsSelected((value) => !value)}
        onFavorite={vi.fn()}
        hasPlaylists={false}
        onAddToPlaylist={vi.fn()}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  return container;
}

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(async () => root.unmount());
  if (originalVisibilityState)
    Object.defineProperty(document, 'visibilityState', originalVisibilityState);
  else Reflect.deleteProperty(document, 'visibilityState');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('player ufficiale YouTube', () => {
  it('carica solo l’embed ufficiale visibile con controlli e senza autoplay', async () => {
    const container = await mount();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('Canale indicato da YouTube');
    expect(container.textContent).toContain('Descrizione ufficiale.');

    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.includes('Apri player'),
    );
    if (!button) throw new Error('Controllo per aprire il player non trovato.');
    await act(async () => button.click());

    const iframe = container.querySelector<HTMLIFrameElement>('iframe');
    expect(iframe).not.toBeNull();
    if (!iframe) throw new Error('Player ufficiale non montato dopo la selezione.');
    const playerUrl = new URL(iframe.src);
    expect(playerUrl.origin).toBe('https://www.youtube.com');
    expect(playerUrl.pathname).toBe('/embed/' + video.videoId);
    expect(playerUrl.searchParams.get('enablejsapi')).toBe('1');
    expect(playerUrl.searchParams.get('controls')).toBe('1');
    expect(playerUrl.searchParams.get('playsinline')).toBe('1');
    expect(iframe.hasAttribute('allowfullscreen')).toBe(true);
    expect(iframe.getAttribute('allow')).not.toContain('autoplay');
    expect(iframe.getAttribute('allow')).not.toContain('picture-in-picture');
  });

  it('rimuove il player quando la pagina va in background e richiede un nuovo clic al ritorno', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const container = await mount(true);
    expect(container.querySelector('iframe')).not.toBeNull();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('Player sospeso');

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(container.querySelector('iframe')).toBeNull();
    const reload = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === 'Ricarica player YouTube',
    );
    if (!reload) throw new Error('Controllo per riaprire il player non trovato.');
    await act(async () => reload.click());
    expect(container.querySelector('iframe')).not.toBeNull();

    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('Player sospeso');
  });
});
