// @polsia:user-owned — tasto «Apri in YouTube» (funzione «Ho YouTube Premium»): nascosto se la
// preferenza è spenta o se il brano non ha un video YouTube valido; con entrambi, apre il video
// esatto su YouTube in una nuova scheda. Nessuna API: è solo un link.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YouTubePremiumButton } from '@/components/custom/music/youtube-premium-button';
import { setYouTubePremium } from '@/lib/music/youtube-premium';

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  try {
    window.localStorage.clear();
  } catch {
    // storage non disponibile: nulla da pulire.
  }
});

function renderButton(videoId: string | null) {
  act(() => {
    root = createRoot(container);
    root.render(<YouTubePremiumButton videoId={videoId} />);
  });
}

describe('YouTubePremiumButton', () => {
  it('nascosto se «Ho Premium» è spento', () => {
    setYouTubePremium(false);
    renderButton('dQw4w9WgXcQ');
    expect(container.querySelector('a')).toBeNull();
  });

  it('nascosto senza un video YouTube valido', () => {
    setYouTubePremium(true);
    renderButton(null);
    expect(container.querySelector('a')).toBeNull();
  });

  it('con Premium e video valido apre il video esatto su YouTube, in una nuova scheda', () => {
    setYouTubePremium(true);
    renderButton('dQw4w9WgXcQ');
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(link?.textContent).toContain('Apri in YouTube');
  });
});
