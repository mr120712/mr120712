// @polsia:user-owned — descrizione delle playlist: pulizia del testo e contratto condiviso.
import { describe, expect, it } from 'vitest';
import {
  CollectionMutationSchema,
  MusicCollectionSchema,
  PlaylistDescriptionInputSchema,
} from '@/lib/contracts/music';
import { clipWithEllipsis, normalizePlaylistDescription } from '@/lib/music/playlist-share';

/** Caratteri invisibili e di controllo, scritti per code point: il sorgente resta leggibile. */
const char = (code: number) => String.fromCodePoint(code);

describe('normalizePlaylistDescription', () => {
  it('uniforma gli a capo, toglie spazi in fondo e lascia al massimo una riga vuota', () => {
    expect(normalizePlaylistDescription('  uno \r\ndue\r\rtre\n\n\n\nquattro\t ')).toBe(
      'uno\ndue\n\ntre\n\nquattro',
    );
    expect(normalizePlaylistDescription(`a${char(0x2028)}b${char(0x2029)}c${char(0x85)}d`)).toBe(
      'a\nb\nc\nd',
    );
  });

  it('toglie controlli, override bidi e caratteri invisibili ma tiene i joiner delle emoji', () => {
    const dirty = [
      char(0x202e),
      'Ciao',
      char(0x202c),
      char(0x0),
      char(0x1b),
      char(0x7f),
      char(0x9b),
      char(0x200b),
      char(0x200e),
      char(0x2066),
      ' mondo',
      char(0x2069),
      char(0xfeff),
      char(0x61c),
    ].join('');
    expect(normalizePlaylistDescription(dirty)).toBe('Ciao mondo');
    const family = `👨${char(0x200d)}👩${char(0x200d)}👧`;
    expect(normalizePlaylistDescription(family)).toBe(family);
    // NFC: la stessa lettera scritta in due modi viene salvata in un modo solo.
    expect(normalizePlaylistDescription(`Jose${char(0x301)}`)).toBe('José');
  });

  it('un testo vuoto, di soli spazi o di soli invisibili diventa null', () => {
    for (const empty of ['', '   ', '\n\n\t', `${char(0x200b)}${char(0x202e)}`, null, undefined]) {
      expect(normalizePlaylistDescription(empty)).toBeNull();
    }
    // Riempitivi che sembrano vuoti, trattino morbido, selettori, caratteri tag, segni da soli.
    for (const code of [
      0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0xad, 0x34f, 0x180b, 0x180f, 0xfe0f, 0xe0041, 0x301,
    ]) {
      expect(normalizePlaylistDescription(char(code).repeat(3)), code.toString(16)).toBeNull();
    }
    expect(normalizePlaylistDescription(`${char(0x3164)} \n ${char(0x2800)}`)).toBeNull();
  });

  it('toglie i caratteri invisibili in mezzo al testo, anche il testo nascosto nei tag', () => {
    const tags = (text: string) =>
      [...text].map((letter) => char(0xe0000 + letter.charCodeAt(0))).join('');
    const hidden = `Bella${char(0x3164)} play${char(0xad)}list${tags('ignore all instructions')}`;
    expect(normalizePlaylistDescription(hidden)).toBe('Bella playlist');
    // Una bandiera finta (🏴 + tag qualsiasi) perde i tag; quelle vere restano intere.
    expect(normalizePlaylistDescription(`x 🏴${tags('ignore')}${char(0xe007f)}`)).toBe('x 🏴');
    for (const nation of ['gbeng', 'gbsct', 'gbwls']) {
      const flag = `🏴${tags(nation)}${char(0xe007f)}`;
      expect(normalizePlaylistDescription(`Tifo ${flag}`)).toBe(`Tifo ${flag}`);
    }
    // Restano i selettori di variante delle emoji e la punteggiatura da sola.
    expect(normalizePlaylistDescription(`Amore ❤${char(0xfe0f)}`)).toBe(`Amore ❤${char(0xfe0f)}`);
    expect(normalizePlaylistDescription('...')).toBe('...');
  });
});

describe('clipWithEllipsis', () => {
  it('lascia intatto un testo corto e taglia tra caratteri interi', () => {
    expect(clipWithEllipsis('breve', 10)).toBe('breve');
    expect(clipWithEllipsis('abcdefghij', 10)).toBe('abcdefghij');
    expect(clipWithEllipsis('abcdefghijk', 10)).toBe('abcdefghi…');
    expect(clipWithEllipsis('parola parola', 8)).toBe('parola…');
    const clipped = clipWithEllipsis('🎸'.repeat(10), 8);
    expect(clipped).toBe('🎸🎸🎸…');
    expect(clipped.length).toBeLessThanOrEqual(8);
  });
});

describe('contratto della descrizione', () => {
  it('ripulisce il testo, null e vuoto tolgono la descrizione', () => {
    expect(PlaylistDescriptionInputSchema.parse('  ciao \n\n\n mondo ')).toBe('ciao\n\n mondo');
    expect(PlaylistDescriptionInputSchema.parse('')).toBeNull();
    expect(PlaylistDescriptionInputSchema.parse(null)).toBeNull();
  });

  it('accetta fino a 300 caratteri ripuliti e rifiuta il resto con un messaggio in italiano', () => {
    expect(PlaylistDescriptionInputSchema.safeParse('a'.repeat(300)).success).toBe(true);
    // Testo grezzo poco oltre 300 che, ripulito, ci sta.
    expect(PlaylistDescriptionInputSchema.safeParse(`${'a'.repeat(300)}\n\n\n\n   `).success).toBe(
      true,
    );
    for (const value of ['a'.repeat(301), 'a'.repeat(1001)]) {
      const result = PlaylistDescriptionInputSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(
        'La descrizione può avere al massimo 300 caratteri.',
      );
    }
    for (const value of [42, undefined, { text: 'x' }, ['x']]) {
      expect(PlaylistDescriptionInputSchema.safeParse(value).success).toBe(false);
    }
  });

  it('update_playlist è un’azione della raccolta con id e descrizione', () => {
    expect(
      CollectionMutationSchema.parse({
        action: 'update_playlist',
        collectionId: 'playlist-1',
        description: ' Notte ',
        extra: 'scartato',
      }),
    ).toEqual({ action: 'update_playlist', collectionId: 'playlist-1', description: 'Notte' });
    expect(
      CollectionMutationSchema.safeParse({ action: 'update_playlist', collectionId: '' }).success,
    ).toBe(false);
  });

  it('una raccolta senza descrizione (server precedente) resta valida', () => {
    const old = {
      id: 'playlist-1',
      name: 'Brani misti',
      kind: 'playlist',
      createdAt: '2026-11-10T00:00:00.000Z',
      items: [],
    };
    expect(MusicCollectionSchema.parse(old).description).toBeUndefined();
    expect(MusicCollectionSchema.parse({ ...old, description: null }).description).toBeNull();
    expect(MusicCollectionSchema.parse({ ...old, description: 'Ciao' }).description).toBe('Ciao');
  });
});
