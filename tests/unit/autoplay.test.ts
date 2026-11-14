// @polsia:user-owned
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import {
  AUTOPLAY_BATCH,
  getAutoplay,
  selectAutoplayCandidates,
  setAutoplay,
} from '@/lib/music/autoplay';

function track(id: string, playbackEligible: boolean): AudiusTrackSearchResult {
  return {
    qualifiedId: `audius:${id}`,
    id,
    title: `Brano ${id}`,
    artistName: 'Artista',
    artistUrl: 'https://audius.co/artista',
    trackUrl: `https://audius.co/artista/${id}`,
    artworkUrl: 'https://artwork.example/x.jpg',
    durationSeconds: 120,
    playbackEligible,
  } as AudiusTrackSearchResult;
}

describe('selectAutoplayCandidates', () => {
  it('tiene solo i brani idonei', () => {
    const picks = selectAutoplayCandidates([track('a', true), track('b', false)], new Set());
    expect(picks.map((t) => t.id)).toEqual(['a']);
  });

  it('salta i brani già visti', () => {
    const seen = new Set(['audius:a']);
    const picks = selectAutoplayCandidates([track('a', true), track('b', true)], seen);
    expect(picks.map((t) => t.id)).toEqual(['b']);
  });

  it('elimina i duplicati nello stesso lotto', () => {
    const picks = selectAutoplayCandidates([track('a', true), track('a', true)], new Set());
    expect(picks.map((t) => t.id)).toEqual(['a']);
  });

  it('rispetta il limite del lotto', () => {
    const many = Array.from({ length: AUTOPLAY_BATCH + 5 }, (_v, i) => track(`t${i}`, true));
    expect(selectAutoplayCandidates(many, new Set())).toHaveLength(AUTOPLAY_BATCH);
    expect(selectAutoplayCandidates(many, new Set(), 3)).toHaveLength(3);
  });

  it('mantiene l’ordine di arrivo', () => {
    const picks = selectAutoplayCandidates(
      [track('c', true), track('a', true), track('b', true)],
      new Set(),
    );
    expect(picks.map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('store autoplay (per dispositivo)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('default spento', () => {
    expect(getAutoplay()).toBe(false);
  });

  it('acceso/spento con round-trip in localStorage', () => {
    setAutoplay(true);
    expect(getAutoplay()).toBe(true);
    setAutoplay(false);
    expect(getAutoplay()).toBe(false);
  });
});
