// @polsia:user-owned — quiz musicale condivisibile: il codice c= va e torna senza perdite (anche
// emoji, CJK, testo da destra a sinistra), ogni codice rovinato dà null senza errori, la risposta
// (l'artista) non compare mai nel testo condiviso, nel link, nei titoli o nell'immagine, il link
// resta sotto il limite e l'indirizzo dell'immagine è canonico.
import { describe, expect, it } from 'vitest';
import {
  publicShareUrl,
  SONG_SHARE_URL_MAX,
  searchParamsRecord,
  shareCardText,
} from '@/lib/business/social-share';
import {
  decodeSongQuizCode,
  QUIZ_CODE_MAX,
  QUIZ_PREVIEW_IMAGE_BASE,
  quizImageFromParams,
  quizPagePath,
  quizPageTitle,
  quizPreviewImagePath,
  quizQuestion,
  quizShareImagePath,
  quizShareText,
  quizSong,
  songQuizFromParams,
  songQuizShare,
  songQuizUrl,
} from '@/lib/business/song-quiz';

const BASE = 'https://www.solcomusic.online';
const TRACK_ID = 'J7Xb000';

/** Un codice c= scritto a mano (UTF-8 → base64url senza "="). */
function rawCode(text: string | Uint8Array, version = '1') {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text);
  return `${version}.${bytes.toString('base64url')}`;
}

function quizOf(url: string) {
  return songQuizFromParams(searchParamsRecord(new URL(url).searchParams));
}

describe('songQuizUrl e songQuizFromParams', () => {
  it.each([
    ['Albachiara', 'Vasco Rossi'],
    ['Help!', 'The Beatles'],
    ['È così (live)', 'Artista Ünïcode'],
    ['Festa 🎉🎶 al mare', 'Gruppo 👩‍👩‍👧 Famiglia'],
    ['夜に駆ける', 'YOASOBI 夜遊び'],
    ['강남스타일', '싸이 Psy'],
    ['أنا لحبيبي', 'فيروز'],
    ['ירושלים של זהב', 'נעמי שמר'],
    ['A & B = C?', 'Né l’uno né l’altro'],
  ])('andata e ritorno: %s · %s', (title, artist) => {
    const url = songQuizUrl({ title, artist }, BASE);
    expect(url).not.toBeNull();
    const link = new URL(String(url));
    expect(link.origin).toBe(BASE);
    expect(link.pathname).toBe('/quiz');
    expect([...link.searchParams.keys()]).toEqual(['c']);
    expect(quizOf(String(url))).toEqual({ title, artist, audiusId: null });
  });

  it('il codice è "1." + base64url (senza "=") di titolo, U+001F, artista', () => {
    const url = String(songQuizUrl({ title: 'Grande', artist: 'Mina' }, BASE));
    const code = new URL(url).searchParams.get('c');
    expect(code).toBe(rawCode('Grande\u001FMina'));
    expect(code).toMatch(/^1\.[A-Za-z0-9_-]+$/);
  });

  it('brano Audius: &au=<id> dopo il codice; un id non valido non entra nel link', () => {
    const url = String(
      songQuizUrl({ title: 'Luci basse', artist: 'Artista Audius', audiusId: TRACK_ID }, BASE),
    );
    expect([...new URL(url).searchParams.keys()]).toEqual(['c', 'au']);
    expect(quizOf(url)).toEqual({
      title: 'Luci basse',
      artist: 'Artista Audius',
      audiusId: TRACK_ID,
    });
    const bad = String(
      songQuizUrl({ title: 'Luci basse', artist: 'Artista', audiusId: 'playlist:x' }, BASE),
    );
    expect(new URL(bad).searchParams.has('au')).toBe(false);
  });

  it('testo pulito come i link condivisi: spazi, indirizzi web e caratteri di controllo', () => {
    const url = String(
      songQuizUrl(
        {
          title: '  Notte\u001F  chiara www.evil.example/x ',
          artist: 'Artista\u0000 https://evil.example Uno\u202E',
        },
        BASE,
      ),
    );
    expect(quizOf(url)).toEqual({ title: 'Notte chiara', artist: 'Artista Uno', audiusId: null });
  });

  it('senza titolo o senza artista (anche dopo la pulizia) non c’è quiz', () => {
    expect(songQuizUrl({ title: 'Brano', artist: '' }, BASE)).toBeNull();
    expect(songQuizUrl({ title: 'Brano', artist: null }, BASE)).toBeNull();
    expect(songQuizUrl({ title: '   ', artist: 'Mina' }, BASE)).toBeNull();
    expect(songQuizUrl({ title: 'https://evil.example', artist: 'Mina' }, BASE)).toBeNull();
    expect(songQuizUrl({ title: 'Brano', artist: '\u0000\u001F' }, BASE)).toBeNull();
  });

  it('resta sotto il limite: si accorcia il titolo, mai l’artista', () => {
    const title = '😀'.repeat(200);
    const artist = '🎸'.repeat(200);
    const id = 'A'.repeat(128);
    const url = String(songQuizUrl({ title, artist, audiusId: id }, BASE));
    expect(url.length).toBeLessThanOrEqual(SONG_SHARE_URL_MAX);
    const code = new URL(url).searchParams.get('c') ?? '';
    expect(code.length).toBeLessThanOrEqual(QUIZ_CODE_MAX);
    const quiz = quizOf(url);
    expect(quiz?.artist).toBe(shareCardText(artist, 'artist'));
    expect(quiz?.audiusId).toBe(id);
    expect(shareCardText(title, 'title').startsWith(quiz?.title ?? 'x')).toBe(true);
    expect(quiz?.title.length).toBeGreaterThan(0);

    // Un'origine lunghissima: il titolo si accorcia ancora, l'artista resta intero.
    const longBase = `https://${Array.from({ length: 14 }, () => 'a'.repeat(60)).join('.')}.example`;
    const tight = String(songQuizUrl({ title, artist }, longBase));
    expect(tight.length).toBeLessThanOrEqual(SONG_SHARE_URL_MAX);
    expect(quizOf(tight)?.artist).toBe(shareCardText(artist, 'artist'));
    expect(quizOf(tight)?.title.length).toBeLessThan(quiz?.title.length ?? 0);
    expect(quizOf(tight)?.title.length).toBeGreaterThan(0);
  });

  it('il primo valore di un parametro ripetuto, come le pagine Next', () => {
    const first = rawCode('Uno\u001FPrimo');
    expect(songQuizFromParams({ c: [first, rawCode('Due\u001FSecondo')] })).toEqual({
      title: 'Uno',
      artist: 'Primo',
      audiusId: null,
    });
  });
});

describe('codici rovinati: sempre null, mai un errore', () => {
  const invalid: Array<[string, unknown]> = [
    ['assente', undefined],
    ['vuoto', ''],
    ['non stringa', 42],
    ['solo il prefisso', '1.'],
    ['versione sconosciuta', rawCode('Brano\u001FArtista', '2')],
    ['senza versione', Buffer.from('Brano\u001FArtista').toString('base64url')],
    ['caratteri fuori dal base64url', '1.QnJh!m8'],
    ['base64 classico con "="', `${rawCode('Brano\u001FArtist')}=`],
    ['lunghezza impossibile', '1.QnJhb'],
    ['UTF-8 non valido', rawCode(new Uint8Array([0x42, 0xff, 0xfe, 0x1f, 0x41]))],
    ['UTF-8 troncato', rawCode(new Uint8Array([0x41, 0x1f, 0xe2, 0x82]))],
    ['surrogato codificato', rawCode(new Uint8Array([0x41, 0x1f, 0xed, 0xa0, 0x80]))],
    ['senza separatore', rawCode('Brano Artista')],
    ['due separatori', rawCode('Brano\u001FArtista\u001FAltro')],
    ['titolo vuoto', rawCode('\u001FArtista')],
    ['artista vuoto', rawCode('Brano\u001F')],
    ['solo spazi', rawCode('   \u001F   ')],
    ['titolo solo indirizzo web', rawCode('https://evil.example/x\u001FArtista')],
    ['surrogato solo nel testo', '1.\uD800QQ'],
  ];

  it.each(invalid)('%s', (_name, code) => {
    expect(() => decodeSongQuizCode(code)).not.toThrow();
    expect(decodeSongQuizCode(code)).toBeNull();
    expect(songQuizFromParams({ c: code as string | undefined, au: TRACK_ID })).toBeNull();
  });

  it('un solo codice per testo: bit avanzati non nulli rifiutati', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const good = rawCode('A\u001FBC');
    const last = good.at(-1) ?? 'A';
    const bad = `${good.slice(0, -1)}${alphabet[alphabet.indexOf(last) | 1]}`;
    expect(bad).not.toBe(good);
    expect(decodeSongQuizCode(good)).toEqual({ title: 'A', artist: 'BC' });
    expect(decodeSongQuizCode(bad)).toBeNull();
  });

  it('oltre ~1 KB si rifiuta anche un codice altrimenti valido', () => {
    const big = rawCode(`${'a'.repeat(800)}\u001FArtista`);
    expect(big.length).toBeGreaterThan(QUIZ_CODE_MAX);
    expect(decodeSongQuizCode(big)).toBeNull();
    // Enorme: rifiutato subito, senza decodificare.
    expect(decodeSongQuizCode(`1.${'A'.repeat(5_000_000)}`)).toBeNull();
    // Un codice valido al limite passa (il titolo viene comunque limitato a 120 caratteri).
    const atLimit = rawCode(`${'a'.repeat(400)}\u001FArtista`);
    expect(atLimit.length).toBeLessThanOrEqual(QUIZ_CODE_MAX);
    expect(decodeSongQuizCode(atLimit)).toEqual({ title: 'a'.repeat(120), artist: 'Artista' });
  });

  it('un BOM UTF-8 iniziale non entra nel titolo', () => {
    const code = rawCode(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('Brano\u001FArtista')]));
    expect(decodeSongQuizCode(code)).toEqual({ title: 'Brano', artist: 'Artista' });
  });
});

describe('la risposta non si vede mai prima di girare la carta', () => {
  const cases: Array<[string, string, string | null]> = [
    ['Grande grande grande', 'Mina Mazzini', null],
    ['Luci basse', 'Artista Audius', TRACK_ID],
    ['夜に駆ける', 'YOASOBI', null],
    ['أنا لحبيبي', 'فيروز', null],
    ['Help!', 'The Beatles', 'Ab_-9'],
  ];

  it.each(cases)('%s · %s', (title, artist, audiusId) => {
    const url = String(songQuizUrl({ title, artist, audiusId }, BASE));
    const visible = [
      url,
      decodeURIComponent(url),
      quizShareText(title),
      quizPageTitle(title),
      quizQuestion(title),
      quizShareImagePath(url),
      decodeURIComponent(quizShareImagePath(url)),
      quizPreviewImagePath(quizOf(url)),
    ];
    for (const text of visible) {
      expect(text.toLowerCase(), text).not.toContain(artist.toLowerCase());
      expect(text, text).not.toContain(encodeURIComponent(artist));
    }
    expect(quizShareText(title)).toBe(`Sai chi interpreta «${title}»? Gira la carta su Solco.`);
    expect(quizPageTitle(title)).toBe(`Quiz: chi interpreta «${title}»?`);
  });

  it('l’immagine porta solo il titolo o solo l’id Audius', () => {
    const plain = String(songQuizUrl({ title: 'Notte chiara', artist: 'Artista Uno' }, BASE));
    expect(quizShareImagePath(plain)).toBe('/quiz/anteprima.jpg?t=Notte%20chiara');
    const audius = String(
      songQuizUrl({ title: 'Luci basse', artist: 'Artista Audius', audiusId: TRACK_ID }, BASE),
    );
    expect(quizShareImagePath(audius)).toBe(`/quiz/anteprima.jpg?au=${TRACK_ID}`);
  });

  it('testo di ripiego senza titolo', () => {
    expect(quizShareText('   ')).toBe('Sai chi interpreta questo brano? Gira la carta su Solco.');
  });
});

describe('titolo che contiene l’artista (molti upload Audius e Jamendo)', () => {
  it('«Artista - Titolo»: la parte con l’artista si toglie dalla domanda', () => {
    const song = {
      title: 'Skrillex - Bangarang (feat. Sirah)',
      artist: 'Skrillex',
      audiusId: 'Ab1',
    };
    const share = songQuizShare(song, BASE);
    expect(share).not.toBeNull();
    expect(share?.title).toBe('Bangarang (feat. Sirah)');
    expect(share?.text).toBe(
      'Sai chi interpreta «Bangarang (feat. Sirah)»? Gira la carta su Solco.',
    );
    expect(quizOf(String(share?.url))).toEqual({
      title: 'Bangarang (feat. Sirah)',
      artist: 'Skrillex',
      audiusId: 'Ab1',
    });
    // Senza id Audius l'immagine porta il titolo: anche lì senza l'artista.
    const plain = songQuizShare({ ...song, audiusId: null }, BASE);
    expect(plain?.imageUrl).toBe('/quiz/anteprima.jpg?t=Bangarang%20%28feat.%20Sirah%29');
    for (const text of [
      share?.text,
      share?.imageUrl,
      plain?.imageUrl,
      decodeURIComponent(String(plain?.imageUrl)),
      quizPageTitle(String(share?.title)),
    ]) {
      expect(String(text).toLowerCase()).not.toContain('skrillex');
    }
  });

  it.each([
    ['Skrillex - Bangarang', 'Skrillex', 'Bangarang'],
    ['SKRILLEX – Bangarang', 'Skrillex', 'Bangarang'],
    ['Bangarang - Skrillex', 'Skrillex', 'Bangarang'],
    ['Beyoncé | Halo', 'Beyonce', 'Halo'],
    ['Adele: Hello', 'Adele', 'Hello'],
    ['AC/DC - Back in Black', 'AC/DC', 'Back in Black'],
    ['周杰伦 - 晴天', '周杰伦', '晴天'],
  ])('%s (%s) → «%s»', (title, artist, expected) => {
    expect(quizSong({ title, artist })).toEqual({ title: expected, artist });
  });

  it.each([
    ['Killer Queen', 'Queen'],
    ['Skrillex - Skrillex - Intro', 'Skrillex'],
    ['Intro - Skrillex feat. Diplo', 'Skrillex'],
    ['Il mio nome è Mina', 'MINA'],
    ['周杰伦晴天', '周杰伦'],
    ['Skrillex', 'Skrillex'],
  ])('l’artista resta leggibile nel titolo: nessun quiz (%s · %s)', (title, artist) => {
    expect(quizSong({ title, artist })).toBeNull();
    expect(songQuizUrl({ title, artist }, BASE)).toBeNull();
    expect(songQuizShare({ title, artist }, BASE)).toBeNull();
  });

  it('solo parole intere: un artista dentro un’altra parola non blocca il quiz', () => {
    expect(quizSong({ title: 'Rapture', artist: 'Ra' })).toEqual({
      title: 'Rapture',
      artist: 'Ra',
    });
    expect(quizSong({ title: 'Queens of the night', artist: 'Queen' })).not.toBeNull();
  });

  it('un codice scritto a mano con l’artista nel titolo non apre un quiz', () => {
    expect(decodeSongQuizCode(rawCode('Killer Queen\u001FQueen'))).toBeNull();
    // «Artista - Titolo» nel codice: si legge come lo scriverebbe songQuizUrl.
    expect(decodeSongQuizCode(rawCode('Queen - Bohemian Rhapsody\u001FQueen'))).toEqual({
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
    });
  });

  it('quizSong è idempotente e il link si rilegge identico', () => {
    const songs: Array<[string, string]> = [
      ['Skrillex - Bangarang (feat. Sirah)', 'Skrillex'],
      ['Albachiara', 'Vasco Rossi'],
      [`${'Ж'.repeat(119)}😀😀`, 'Ω'.repeat(90)],
    ];
    for (const [title, artist] of songs) {
      const once = quizSong({ title, artist });
      expect(once).not.toBeNull();
      expect(quizSong(once ?? { title: '', artist: '' })).toEqual(once);
      const url = String(songQuizUrl({ title, artist }, BASE));
      const read = quizOf(url);
      expect(songQuizUrl(read ?? { title: '', artist: '' }, BASE)).toBe(url);
    }
  });
});

describe('og:url della pagina del quiz', () => {
  it('il percorso del link ricostruito dal quiz letto, o /quiz', () => {
    const url = String(
      songQuizUrl({ title: 'Luci basse', artist: 'Artista', audiusId: TRACK_ID }, BASE),
    );
    expect(quizPagePath(quizOf(url))).toBe(url.slice(BASE.length));
    expect(quizPagePath(null)).toBe('/quiz');
  });
});

describe('indirizzo canonico della scheda', () => {
  it('stessa scheda dal menu di condivisione e dalla pagina', () => {
    for (const [title, artist, audiusId] of [
      ['  Help!  (Remastered) ', 'The   Beatles', null],
      [`${'Ж'.repeat(119)}😀😀`, 'Ω'.repeat(90), null],
      ['Brano www.evil.example', 'Artista', null],
      ['Luci basse', 'Artista', TRACK_ID],
    ] as const) {
      const url = String(songQuizUrl({ title, artist, audiusId }, BASE));
      expect(quizShareImagePath(url), title).toBe(quizPreviewImagePath(quizOf(url)));
    }
  });

  it('il canonico di un canonico è sé stesso', () => {
    for (const title of [
      'Notte chiara',
      'Help!',
      'È così',
      '😀'.repeat(130),
      `${'a'.repeat(118)} htt`,
      'Titolo � rotto',
      'www.a www.b fine',
      'will.i.am',
    ]) {
      const path = quizPreviewImagePath({ title });
      const query = new URL(path, BASE).searchParams;
      expect(quizPreviewImagePath(quizImageFromParams(searchParamsRecord(query))), title).toBe(
        path,
      );
    }
    const audius = quizPreviewImagePath({ title: 'ignorato', audiusId: TRACK_ID });
    expect(audius).toBe(`/quiz/anteprima.jpg?au=${TRACK_ID}`);
    expect(quizPreviewImagePath(quizImageFromParams({ au: TRACK_ID, t: 'Altro titolo' }))).toBe(
      audius,
    );
  });

  it('senza brano: la scheda generica, senza query', () => {
    expect(quizPreviewImagePath(null)).toBe(QUIZ_PREVIEW_IMAGE_BASE);
    expect(quizPreviewImagePath({ title: '   ' })).toBe(QUIZ_PREVIEW_IMAGE_BASE);
    expect(quizImageFromParams({})).toBeNull();
    expect(quizImageFromParams({ t: 'https://evil.example' })).toBeNull();
    expect(quizImageFromParams({ au: 'non valido' })).toBeNull();
    expect(quizShareImagePath(publicShareUrl('/quiz', BASE))).toBe(QUIZ_PREVIEW_IMAGE_BASE);
    expect(quizShareImagePath(publicShareUrl('/quiz?c=rotto', BASE))).toBe(QUIZ_PREVIEW_IMAGE_BASE);
  });
});
