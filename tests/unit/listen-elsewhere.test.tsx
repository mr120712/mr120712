// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListenElsewhereMenu } from '@/components/custom/music/listen-elsewhere-menu';
import { listenElsewhereLinks, youtubeMusicUrl } from '@/lib/business/shared-song';

describe('link "Ascolta altrove"', () => {
  it('crea i link di ricerca dei cinque servizi, con artista e titolo', () => {
    const links = listenElsewhereLinks({ title: ' Albachiara ', artist: 'Vasco  Rossi' });
    expect(links.map((link) => [link.id, link.href])).toEqual([
      ['spotify', 'https://open.spotify.com/search/Vasco%20Rossi%20Albachiara'],
      ['youtube-music', 'https://music.youtube.com/search?q=Vasco%20Rossi%20Albachiara'],
      ['soundcloud', 'https://soundcloud.com/search/sounds?q=Vasco%20Rossi%20Albachiara'],
      ['deezer', 'https://www.deezer.com/search/Vasco%20Rossi%20Albachiara'],
      ['tidal', 'https://tidal.com/search?q=Vasco%20Rossi%20Albachiara'],
    ]);
  });

  it('per un video YouTube apre lo stesso video in YouTube Music', () => {
    const [, ytm] = listenElsewhereLinks({
      title: 'X',
      artist: null,
      youtubeVideoId: 'dQw4w9WgXcQ',
    });
    expect(ytm).toEqual({
      id: 'youtube-music',
      label: 'Apri in YouTube Music',
      href: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    // An invalid id never reaches the URL: falls back to a search.
    expect(youtubeMusicUrl('X', null, 'bad id"><')).toBe('https://music.youtube.com/search?q=X');
  });

  it('senza titolo non mostra nulla', () => {
    expect(listenElsewhereLinks({ title: '   ', artist: 'A' })).toEqual([]);
  });
});

describe('menu "Ascolta altrove"', () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('mostra il pulsante; il menu contiene link esterni sicuri', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(<ListenElsewhereMenu title="Albachiara" artist="Vasco Rossi" />),
    );
    const trigger = container.querySelector('button');
    expect(trigger?.textContent).toContain('Ascolta altrove');
    // Opened from the keyboard (Enter), like a keyboard or screen-reader user.
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const anchors = [...document.querySelectorAll('a')];
    expect(anchors).toHaveLength(5);
    for (const anchor of anchors) {
      expect(anchor.target).toBe('_blank');
      expect(anchor.rel).toBe('noopener noreferrer');
      expect(anchor.textContent).toContain('si apre in una nuova scheda');
    }
    expect(anchors.map((anchor) => anchor.textContent?.split(' (')[0])).toEqual([
      'Apri in Spotify',
      'Cerca su YouTube Music',
      'Cerca su SoundCloud',
      'Cerca su Deezer',
      'Cerca su TIDAL',
    ]);
  });

  it('senza titolo non rende nulla', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ListenElsewhereMenu title=" " artist={null} />));
    expect(container.innerHTML).toBe('');
  });
});
