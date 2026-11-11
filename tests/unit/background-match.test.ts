// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  backgroundSearchQuery,
  bestMatch,
  normalizeMusicText,
  parseVideoTitle,
} from '@/lib/music/background-match';

const video = {
  title: 'Artista Uno - Notte Chiara (Official Video)',
  channelTitle: 'ArtistaUnoVEVO',
};

describe('ascolta in background: corrispondenza dei brani', () => {
  it('pulisce titoli e separa artista e titolo', () => {
    expect(normalizeMusicText('Notte Chiàra (Official Video) [4K]')).toBe('notte chiara');
    expect(parseVideoTitle(video.title, video.channelTitle)).toEqual({
      artist: 'Artista Uno',
      title: 'Notte Chiara (Official Video)',
    });
    expect(backgroundSearchQuery(video.title, video.channelTitle)).toBe('artista uno notte chiara');
  });

  it('sceglie lo stesso brano dello stesso artista', () => {
    const match = bestMatch(video, [
      { title: 'Notte Chiara (Remix di Altri)', artistName: 'DJ Altro' },
      { title: 'Notte Chiara', artistName: 'Artista Uno' },
    ]);
    expect(match?.artistName).toBe('Artista Uno');
  });

  it('non propone brani diversi o di altri artisti', () => {
    expect(
      bestMatch(video, [
        { title: 'Notte', artistName: 'Artista Uno' },
        { title: 'Notte Chiara', artistName: 'Qualcun Altro' },
      ]),
    ).toBeNull();
  });
});
