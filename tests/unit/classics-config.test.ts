// @polsia:user-owned — la config dei classici deve usare solo generi/mood Audius validi.
import { describe, expect, it } from 'vitest';
import { CLASSICS_DECADES } from '@/lib/music/classics';
import { AUDIUS_GENRES, AUDIUS_MOODS } from '@/lib/music/moods';

describe('config Classici per decennio', () => {
  it('copre i quattro decenni con slug unici', () => {
    const slugs = CLASSICS_DECADES.map((d) => d.slug);
    expect(slugs).toEqual(['60s', '70s', '80s', '90s']);
    expect(new Set(slugs).size).toBe(4);
  });

  it('ogni playlist usa generi e mood Audius validi, con id unici nel decennio', () => {
    const genres = new Set<string>(AUDIUS_GENRES);
    const moods = new Set<string>(AUDIUS_MOODS);
    for (const decade of CLASSICS_DECADES) {
      const ids = decade.playlists.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(decade.playlists.length).toBeGreaterThan(0);
      for (const playlist of decade.playlists) {
        expect(playlist.genres.length).toBeGreaterThan(0);
        for (const genre of playlist.genres) expect(genres.has(genre)).toBe(true);
        for (const mood of playlist.moods ?? []) expect(moods.has(mood)).toBe(true);
      }
    }
  });
});
