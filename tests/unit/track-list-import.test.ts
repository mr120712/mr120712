// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  parseTrackList,
  songIdentity,
  TRACK_LIST_MAX_TRACKS,
} from '@/lib/business/track-list-import';

describe('importa elenco brani: righe di testo', () => {
  it('legge "Artista - Titolo", numerazioni e righe senza artista', () => {
    const result = parseTrackList(
      '1. Gruppo Inventato - Luce del Mattino\n02) Band Finta – Strada Nuova\n• Solo Titolo\n\n  ',
    );
    expect(result.format).toBe('lines');
    expect(result.tracks).toEqual([
      {
        title: 'Luce del Mattino',
        artist: 'Gruppo Inventato',
        durationSeconds: null,
        sourceUrl: null,
      },
      { title: 'Strada Nuova', artist: 'Band Finta', durationSeconds: null, sourceUrl: null },
      { title: 'Solo Titolo', artist: null, durationSeconds: null, sourceUrl: null },
    ]);
  });

  it('salta i link senza titolo e i doppioni scritti in modo diverso', () => {
    const result = parseTrackList(
      'https://open.spotify.com/track/0123456789abcdefghijkl\nBand Finta - Strada Nuova\nband finta - STRADA NUOVA!',
    );
    expect(result.tracks).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });
});

describe('importa elenco brani: CSV', () => {
  it('legge un CSV in stile Exportify con virgolette, più artisti, durata e link Spotify', () => {
    const csv = [
      '"Track URI","Track Name","Artist Name(s)","Album Name","Duration (ms)"',
      '"spotify:track:0123456789abcdefghijkl","Luce del Mattino, parte 2","Gruppo Inventato,Altro Artista","Album","215000"',
      '"spotify:track:abcdefghijkl0123456789","Strada ""Nuova""","Band Finta","Album","183500"',
    ].join('\n');
    const result = parseTrackList(csv);
    expect(result.format).toBe('csv');
    expect(result.tracks[0]).toEqual({
      title: 'Luce del Mattino, parte 2',
      artist: 'Gruppo Inventato, Altro Artista',
      durationSeconds: 215,
      sourceUrl: 'https://open.spotify.com/track/0123456789abcdefghijkl',
    });
    expect(result.tracks[1]?.title).toBe('Strada "Nuova"');
  });

  it('riconosce intestazioni di altri servizi e il punto e virgola', () => {
    const csv = 'Titolo;Artista;Durata\nStrada Nuova;Band Finta;3:05\nSenza Artista;;';
    const result = parseTrackList(csv);
    expect(result.tracks[0]).toMatchObject({
      title: 'Strada Nuova',
      artist: 'Band Finta',
      durationSeconds: 185,
    });
    expect(result.tracks[1]).toMatchObject({ title: 'Senza Artista', artist: null });
  });

  it('gestisce a capo dentro le virgolette e limita il numero di brani', () => {
    expect(parseCsv('a,"b\nc",d\n', ',')).toEqual([['a', 'b\nc', 'd']]);
    const many = Array.from(
      { length: TRACK_LIST_MAX_TRACKS + 5 },
      (_, i) => `Artista ${i} - Brano ${i}`,
    );
    const result = parseTrackList(many.join('\n'));
    expect(result.tracks).toHaveLength(TRACK_LIST_MAX_TRACKS);
    expect(result.truncated).toBe(5);
    expect(result.skipped).toBe(0);
  });

  it('usa la stessa identità per lo stesso brano scritto diversamente', () => {
    expect(songIdentity('Strada Nuova!', 'Bänd Finta')).toBe(
      songIdentity('strada nuova', 'band finta'),
    );
  });
});

describe('importa elenco brani: casi difficili (revisione)', () => {
  it('resta veloce con input costruiti apposta (niente backtracking)', () => {
    const start = Date.now();
    parseTrackList(`a${' '.repeat(299_990)}b`);
    parseTrackList(`title,artist\n"x","${' '.repeat(299_000)}y"`);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('tiene distinti i titoli in alfabeti non latini', () => {
    const result = parseTrackList(
      'Группа - Первая песня\nГруппа - Вторая песня\nBand - 첫 노래\nBand - 두번째 노래',
    );
    expect(result.tracks).toHaveLength(4);
    expect(songIdentity('Первая', 'Группа')).not.toBe(songIdentity('Вторая', 'Группа'));
  });

  it('non toglie le cifre dai nomi degli artisti, solo le numerazioni', () => {
    const result = parseTrackList(
      '1. Gruppo - Uno\n2) Gruppo - Due\n3 Gruppo - Tre\n50 Cent - Brano Finto',
    );
    expect(result.tracks.map((t) => t.artist)).toEqual(['Gruppo', 'Gruppo', 'Gruppo', '50 Cent']);
  });

  it('CSV senza colonna artista, a capo Mac, durate fuori scala, id Spotify nudi', () => {
    const csv = parseTrackList(
      'Title,Spotify - ID,Duration\rLuce,0123456789abcdefghijkl,999:00:00\rStrada,,3:05',
    );
    expect(csv.tracks).toEqual([
      {
        title: 'Luce',
        artist: null,
        durationSeconds: null,
        sourceUrl: 'https://open.spotify.com/track/0123456789abcdefghijkl',
      },
      { title: 'Strada', artist: null, durationSeconds: 185, sourceUrl: null },
    ]);
    expect(parseTrackList('Album,Anno\nUno,1999\nDue,2001').error).toBe('missing_columns');
  });

  it('una virgoletta non chiusa non inghiotte il resto del file', () => {
    const result = parseTrackList('title,artist\n"Luce,Gruppo\nStrada,Band');
    expect(result.tracks.map((t) => t.title)).toContain('Strada');
  });
});

describe('importa elenco brani: caratteri strani', () => {
  it('toglie caratteri di controllo e surrogati isolati ma tiene le emoji', () => {
    const result = parseTrackList('Band\u0000 Finta - Strada\u0007 Nuova 🎵\nGruppo - Luce\uD800');
    expect(result.tracks).toEqual([
      { title: 'Strada Nuova 🎵', artist: 'Band Finta', durationSeconds: null, sourceUrl: null },
      { title: 'Luce', artist: 'Gruppo', durationSeconds: null, sourceUrl: null },
    ]);
  });
});
