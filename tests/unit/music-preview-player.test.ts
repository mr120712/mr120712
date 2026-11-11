import { describe, expect, it, vi } from 'vitest';
import { enforcePreviewBoundary } from '@/lib/music/preview-player';

describe('limite dell’anteprima Free', () => {
  it('si ferma al primo tra la durata autorizzata, 40 secondi e la fine del file', () => {
    const pause = vi.fn();
    const media = { currentTime: 40.01, duration: 60, pause };

    expect(enforcePreviewBoundary(media, 40)).toBe(40);
    expect(media.currentTime).toBe(40);
    expect(pause).toHaveBeenCalledOnce();
  });

  it('termina alla fine della preview se autorizzata per meno di 40 secondi', () => {
    const pause = vi.fn();
    const media = { currentTime: 20.1, duration: 20, pause };

    expect(enforcePreviewBoundary(media, 40)).toBe(20);
    expect(media.currentTime).toBe(20);
    expect(pause).toHaveBeenCalledOnce();
  });

  it('usa il limite autorizzato quando è più breve del limite Free', () => {
    const pause = vi.fn();
    const media = { currentTime: 12.5, duration: 60, pause };

    expect(enforcePreviewBoundary(media, 12)).toBe(12);
    expect(media.currentTime).toBe(12);
    expect(pause).toHaveBeenCalledOnce();
  });

  it('rifiuta estratti senza prova di durata positiva', () => {
    const pause = vi.fn();
    expect(enforcePreviewBoundary({ currentTime: 1, duration: 20, pause }, 0)).toBeNull();
    expect(pause).not.toHaveBeenCalled();
  });
});
