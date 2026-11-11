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

import { pickVideoForSong } from '@/lib/music/background-match';

describe('brani importati: scelta del video YouTube', () => {
  const song = {
    title: 'Luce del Mattino - Remastered 2011',
    artist: 'Gruppo Inventato, Altro Artista',
  };
  const videos = [
    {
      videoId: 'aaaaaaaaaaa',
      title: 'Luce del Mattino (Karaoke Version)',
      channelTitle: 'Karaoke Hits',
    },
    {
      videoId: 'bbbbbbbbbbb',
      title: 'Gruppo Inventato - Luce del Mattino (Live 1999)',
      channelTitle: 'Fan Club',
    },
    { videoId: 'ccccccccccc', title: 'Luce del Mattino', channelTitle: 'Gruppo Inventato - Topic' },
    { videoId: 'ddddddddddd', title: 'Notte Fonda', channelTitle: 'Gruppo Inventato' },
  ];

  it('preferisce la versione originale sul canale ufficiale', () => {
    expect(pickVideoForSong(song, videos)?.videoId).toBe('ccccccccccc');
  });

  it('accetta una versione live solo se è quella cercata', () => {
    const live = { title: 'Luce del Mattino (Live 1999)', artist: 'Gruppo Inventato' };
    expect(pickVideoForSong(live, videos)?.videoId).toBe('bbbbbbbbbbb');
  });

  it('non propone un brano diverso o di un altro artista', () => {
    expect(
      pickVideoForSong({ title: 'Altra Canzone', artist: 'Gruppo Inventato' }, videos),
    ).toBeNull();
    expect(
      pickVideoForSong({ title: 'Luce del Mattino', artist: 'Nessuno Qui' }, videos.slice(2)),
    ).toBeNull();
  });
});
