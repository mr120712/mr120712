// @polsia:user-owned
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyElementSpeed,
  clampSpeed,
  DEFAULT_SPEED,
  getPlaybackSpeed,
  MAX_SPEED,
  MIN_SPEED,
  nearestYouTubeRate,
  PLAYBACK_SPEEDS,
  setPlaybackSpeed,
} from '@/lib/music/playback-speed';

afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignora
  }
});

describe('playback-speed · store', () => {
  it('è 1× (normale) per default', () => {
    expect(getPlaybackSpeed()).toBe(DEFAULT_SPEED);
    expect(DEFAULT_SPEED).toBe(1);
  });

  it('persiste il valore scelto', () => {
    setPlaybackSpeed(0.8);
    expect(getPlaybackSpeed()).toBe(0.8);
    setPlaybackSpeed(1.25);
    expect(getPlaybackSpeed()).toBe(1.25);
  });

  it('ritaglia i valori fuori dall’intervallo consentito', () => {
    expect(clampSpeed(5)).toBe(MAX_SPEED);
    expect(clampSpeed(0.01)).toBe(MIN_SPEED);
    expect(clampSpeed(Number.NaN)).toBe(DEFAULT_SPEED);
    setPlaybackSpeed(10);
    expect(getPlaybackSpeed()).toBe(MAX_SPEED);
  });

  it('i preset mostrati includono rallentato, normale e accelerato', () => {
    expect(PLAYBACK_SPEEDS).toContain(1);
    expect(PLAYBACK_SPEEDS.some((s) => s < 1)).toBe(true);
    expect(PLAYBACK_SPEEDS.some((s) => s > 1)).toBe(true);
  });

  it('emette un evento al cambio (per aggiornare i componenti)', () => {
    let fired = 0;
    const handler = () => {
      fired += 1;
    };
    window.addEventListener('solco:playback-speed-changed', handler);
    setPlaybackSpeed(0.9);
    setPlaybackSpeed(1.5);
    window.removeEventListener('solco:playback-speed-changed', handler);
    expect(fired).toBe(2);
  });
});

describe('applyElementSpeed · effetto "slowed / sped up"', () => {
  it('toglie preservesPitch (il tono segue la velocità) e imposta defaultPlaybackRate + playbackRate', () => {
    const element = { playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: true };
    applyElementSpeed(element, 0.8);
    expect(element.preservesPitch).toBe(false);
    expect(element.playbackRate).toBe(0.8);
    // defaultPlaybackRate serve perché load() riporta playbackRate a quel valore.
    expect(element.defaultPlaybackRate).toBe(0.8);
  });

  it('ritaglia la velocità e ignora un elemento assente senza lanciare', () => {
    const element = { playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: true };
    applyElementSpeed(element, 99);
    expect(element.playbackRate).toBe(MAX_SPEED);
    expect(() => applyElementSpeed(null, 1.25)).not.toThrow();
    expect(() => applyElementSpeed(undefined, 1.25)).not.toThrow();
  });
});

describe('nearestYouTubeRate · YouTube accetta solo velocità discrete', () => {
  it('sceglie la velocità disponibile più vicina', () => {
    const available = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    expect(nearestYouTubeRate(0.8, available)).toBe(0.75);
    expect(nearestYouTubeRate(0.9, available)).toBe(1);
    expect(nearestYouTubeRate(1.25, available)).toBe(1.25);
    expect(nearestYouTubeRate(1.6, available)).toBe(1.5);
  });

  it('usa una lista di default quando il player non ne fornisce una', () => {
    expect(nearestYouTubeRate(1.25)).toBe(1.25);
    expect(nearestYouTubeRate(0.8)).toBe(0.75);
  });
});
