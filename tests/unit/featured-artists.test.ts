// @polsia:user-owned — artisti dei brani in evidenza (logica pura): artista principale e ospiti
// ("feat." e varianti, anche più ospiti e fra parentesi), slug (accenti, punteggiatura, tetto di
// 80 caratteri, slug vuoto = nessuna pagina), grafie diverse con lo stesso slug unite sotto la più
// frequente, link della Home solo per gli artisti dichiarati, mescolamento che non perde brani.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ARTIST_SLUG_MAX_LENGTH,
  artistSlug,
  featuredArtistPath,
  groupFeaturedArtists,
  isArtistSlug,
  linkDeclaredArtists,
  parseTrackArtists,
  primaryArtistSlug,
  shuffledCopy,
  trackArtistCredits,
} from '@/lib/music/featured-artists';

function track(id: string, artist: string | null, title = 'Titolo') {
  return { id, artist, title };
}

describe('parseTrackArtists: artista principale e ospiti', () => {
  it.each([
    ['Lucio Dalla feat. Mina', 'Lucio Dalla', ['Mina']],
    ['Lucio Dalla Feat Mina', 'Lucio Dalla', ['Mina']],
    ['Lucio Dalla FEAT. Mina', 'Lucio Dalla', ['Mina']],
    ['Lucio Dalla ft. Mina', 'Lucio Dalla', ['Mina']],
    ['Lucio Dalla ft Mina', 'Lucio Dalla', ['Mina']],
    ['Lucio Dalla featuring Mina', 'Lucio Dalla', ['Mina']],
    ['Lucio Dalla feat.Mina', 'Lucio Dalla', ['Mina']],
    ['Lucio Dalla (feat. Mina)', 'Lucio Dalla', ['Mina']],
    ['Lucio Dalla [ft. Mina]', 'Lucio Dalla', ['Mina']],
  ])('%s → principale %s, ospiti %j', (artist, primary, guests) => {
    expect(parseTrackArtists(artist)).toEqual({ primary, guests });
  });

  it('più ospiti separati da ",", " & " o " e "', () => {
    expect(parseTrackArtists('Lucio Dalla feat. Mina, Celentano & Morandi e Battisti')).toEqual({
      primary: 'Lucio Dalla',
      guests: ['Mina', 'Celentano', 'Morandi', 'Battisti'],
    });
    expect(parseTrackArtists('Band (feat. Uno & Due)').guests).toEqual(['Uno', 'Due']);
  });

  it('senza spazio prima del marcatore non divide: "Daft Punk", "Lift", "Fifty"', () => {
    expect(parseTrackArtists('Daft Punk')).toEqual({ primary: 'Daft Punk', guests: [] });
    expect(parseTrackArtists('Lift Off')).toEqual({ primary: 'Lift Off', guests: [] });
    expect(parseTrackArtists('Fifty Fifty')).toEqual({ primary: 'Fifty Fifty', guests: [] });
  });

  it('nel principale "&" e "," restano (Simon & Garfunkel, Earth, Wind & Fire)', () => {
    expect(parseTrackArtists('Simon & Garfunkel').primary).toBe('Simon & Garfunkel');
    expect(parseTrackArtists('Earth, Wind & Fire feat. Ospite')).toEqual({
      primary: 'Earth, Wind & Fire',
      guests: ['Ospite'],
    });
  });

  it('parentesi del nome restano intere: "Nirvana (UK)"', () => {
    expect(parseTrackArtists('Nirvana (UK)')).toEqual({ primary: 'Nirvana (UK)', guests: [] });
  });

  it('un "(feat. …)" nel titolo aggiunge ospiti, solo se il brano ha un artista', () => {
    expect(parseTrackArtists('Artista', 'Canzone (feat. Ospite & Altra)')).toEqual({
      primary: 'Artista',
      guests: ['Ospite', 'Altra'],
    });
    expect(parseTrackArtists(null, 'Canzone (feat. Ospite)')).toEqual({
      primary: null,
      guests: [],
    });
  });

  it('"ft. …" in coda al titolo, senza parentesi, aggiunge l’ospite (fino a una parentesi)', () => {
    expect(trackArtistCredits({ artist: 'Artista', title: 'Titolo ft. Ospite' })).toEqual([
      { slug: 'artista', name: 'Artista' },
      { slug: 'ospite', name: 'Ospite' },
    ]);
    expect(parseTrackArtists('Artista', 'Titolo feat. Uno & Due (Remix)').guests).toEqual([
      'Uno',
      'Due',
    ]);
    expect(parseTrackArtists('Artista', 'Titolo featuring Ospite').guests).toEqual(['Ospite']);
    // "feat" senza punto in un titolo è anche una parola: nessun ospite inventato.
    expect(parseTrackArtists('Artista', 'A Great Feat of Strength').guests).toEqual([]);
    expect(parseTrackArtists(null, 'Titolo ft. Ospite')).toEqual({ primary: null, guests: [] });
  });

  it('marcatori con ":", separatori e parentesi ai bordi non restano nei nomi', () => {
    expect(parseTrackArtists('Artist featuring: X')).toEqual({ primary: 'Artist', guests: ['X'] });
    expect(parseTrackArtists('Artist feat.: X')).toEqual({ primary: 'Artist', guests: ['X'] });
    expect(parseTrackArtists('Artist & Feat X')).toEqual({ primary: 'Artist', guests: ['X'] });
    expect(parseTrackArtists('Artist, feat. X')).toEqual({ primary: 'Artist', guests: ['X'] });
    expect(parseTrackArtists('Artista e feat. X')).toEqual({ primary: 'Artista', guests: ['X'] });
    expect(parseTrackArtists('Artist feat. (X)')).toEqual({ primary: 'Artist', guests: ['X'] });
    expect(parseTrackArtists('Artist feat. & X')).toEqual({ primary: 'Artist', guests: ['X'] });
    // I nomi veri con "&", "," o parentesi interne restano interi.
    expect(parseTrackArtists('Simon & Garfunkel').primary).toBe('Simon & Garfunkel');
    expect(parseTrackArtists('(hed) p.e.').primary).toBe('(hed) p.e.');
    expect(parseTrackArtists('Vitamin E').primary).toBe('Vitamin E');
  });

  it('senza artista o con un nome vuoto: nessuno; ospite ripetuto o uguale al principale una volta', () => {
    expect(parseTrackArtists(null)).toEqual({ primary: null, guests: [] });
    expect(parseTrackArtists('   ')).toEqual({ primary: null, guests: [] });
    expect(parseTrackArtists('Mina feat. MINA, Celentano', 'Brano (ft. Celentano)')).toEqual({
      primary: 'Mina',
      guests: ['Celentano'],
    });
  });
});

describe('artistSlug', () => {
  it('accenti e lettere latine speciali', () => {
    expect(artistSlug('Mötley Crüe')).toBe('motley-crue');
    expect(artistSlug('Beyoncé')).toBe('beyonce');
    expect(artistSlug('Sigur Rós')).toBe('sigur-ros');
    expect(artistSlug('Ólafur Arnalds')).toBe('olafur-arnalds');
    expect(artistSlug('Die Ärzte')).toBe('die-arzte');
    expect(artistSlug('Straße')).toBe('strasse');
    expect(artistSlug('Røyksopp')).toBe('royksopp');
    expect(artistSlug('Łona')).toBe('lona');
    expect(artistSlug('ＡＢＣ')).toBe('abc');
  });

  it('punteggiatura e spazi → un solo trattino, niente trattini ai bordi', () => {
    expect(artistSlug('AC/DC')).toBe('ac-dc');
    expect(artistSlug('AC-DC')).toBe('ac-dc');
    expect(artistSlug('Simon & Garfunkel')).toBe('simon-garfunkel');
    expect(artistSlug("  --Guns N' Roses!!  ")).toBe('guns-n-roses');
    expect(artistSlug('blink-182')).toBe('blink-182');
  });

  it('al massimo 80 caratteri, senza trattino finale dopo il taglio', () => {
    const long = `${'a'.repeat(79)} bcd`;
    const slug = artistSlug(long);
    expect(slug.length).toBeLessThanOrEqual(ARTIST_SLUG_MAX_LENGTH);
    expect(slug).toBe('a'.repeat(79));
    expect(artistSlug('x'.repeat(200))).toHaveLength(80);
    expect(isArtistSlug(artistSlug(long))).toBe(true);
  });

  it('nessuna lettera latina o cifra → slug vuoto (nessuna pagina)', () => {
    expect(artistSlug('')).toBe('');
    expect(artistSlug('!!!')).toBe('');
    expect(artistSlug('坂本龍一')).toBe('');
    expect(primaryArtistSlug('坂本龍一')).toBeNull();
    expect(primaryArtistSlug(null)).toBeNull();
    expect(trackArtistCredits({ artist: '坂本龍一', title: 'Merry Christmas' })).toEqual([]);
  });

  it('lettere o cifre non latine: slug vuoto anche con un residuo latino o numerico', () => {
    for (const name of [
      '乃木坂46',
      '日向坂46',
      '櫻坂46',
      'Би-2',
      'Ди-2',
      '坂本龍一 & ABC',
      'Ωmega 3',
    ]) {
      expect(artistSlug(name)).toBe('');
    }
    expect(artistSlug('ABC')).toBe('abc');
    // Le lettere modificatrici (apostrofo U+02BC) contano come punteggiatura.
    expect(artistSlug('Guns Nʼ Roses')).toBe('guns-n-roses');
    // Forme di compatibilità che NFKD riporta al latino restano valide.
    expect(artistSlug('Ⅻ ①')).toBe('xii-1');
  });

  it('artisti diversi con lo stesso residuo non finiscono sulla stessa pagina', () => {
    const groups = groupFeaturedArtists([
      track('1', '乃木坂46'),
      track('2', '乃木坂46'),
      track('3', '日向坂46'),
      track('4', '坂本龍一 & ABC'),
      track('5', 'ABC'),
    ]);
    expect([...groups.keys()]).toEqual(['abc']);
    expect(groups.get('abc')?.tracks.map((t) => t.id)).toEqual(['5']);
  });

  it('isArtistSlug e featuredArtistPath', () => {
    expect(isArtistSlug('lucio-dalla')).toBe(true);
    expect(isArtistSlug('blink-182')).toBe(true);
    for (const bad of ['', 'Lucio-Dalla', 'a--b', '-a', 'a-', 'a b', '../x', 'é', 'a'.repeat(81)]) {
      expect(isArtistSlug(bad)).toBe(false);
    }
    expect(featuredArtistPath('lucio-dalla')).toBe('/artista/lucio-dalla');
  });
});

describe('groupFeaturedArtists', () => {
  it('un brano appartiene al principale e a ogni ospite; senza artista nessuna pagina', () => {
    const groups = groupFeaturedArtists([
      track('1', 'Lucio Dalla feat. Mina & Celentano'),
      track('2', 'Mina'),
      track('3', null),
      track('4', 'Lucio Dalla', 'Canzone (feat. Morandi)'),
    ]);
    expect([...groups.keys()].sort()).toEqual(['celentano', 'lucio-dalla', 'mina', 'morandi']);
    expect(groups.get('lucio-dalla')?.tracks.map((t) => t.id)).toEqual(['1', '4']);
    expect(groups.get('mina')?.tracks.map((t) => t.id)).toEqual(['1', '2']);
    expect(groups.get('celentano')?.tracks.map((t) => t.id)).toEqual(['1']);
    expect(groups.get('morandi')?.tracks.map((t) => t.id)).toEqual(['4']);
    for (const group of groups.values()) expect(group.tracks.length).toBeGreaterThan(0);
  });

  it('grafie diverse con lo stesso slug: una pagina, col nome più frequente', () => {
    const groups = groupFeaturedArtists([
      track('1', 'LUCIO DALLA'),
      track('2', 'Lucio Dalla'),
      track('3', 'Lucio Dallà'),
      track('4', 'Lucio Dalla'),
    ]);
    expect([...groups.keys()]).toEqual(['lucio-dalla']);
    expect(groups.get('lucio-dalla')).toMatchObject({ slug: 'lucio-dalla', name: 'Lucio Dalla' });
    expect(groups.get('lucio-dalla')?.tracks).toHaveLength(4);
  });

  it('a parità di frequenza vince la grafia del brano che viene prima (il più recente)', () => {
    const groups = groupFeaturedArtists([track('1', 'AC/DC'), track('2', 'AC-DC')]);
    expect(groups.get('ac-dc')?.name).toBe('AC/DC');
  });

  it('un artista ripetuto nello stesso brano conta quel brano una volta', () => {
    const groups = groupFeaturedArtists([track('1', 'Mina feat. Mina', 'X (ft. MINA)')]);
    expect(groups.get('mina')?.tracks.map((t) => t.id)).toEqual(['1']);
  });
});

describe('linkDeclaredArtists (Home)', () => {
  it('artistSlug solo se l’artista principale è fra quelli dichiarati', () => {
    const declared = new Set(['lucio-dalla']);
    const linked = linkDeclaredArtists(
      [
        track('dichiarato', 'Lucio Dalla'),
        track('stesso-artista-non-dichiarato', 'LUCIO DALLA feat. Altro'),
        track('altro', 'Artista Commerciale'),
        track('senza', null),
      ],
      declared,
    );
    expect(linked.map((t) => [t.id, t.artistSlug])).toEqual([
      ['dichiarato', 'lucio-dalla'],
      ['stesso-artista-non-dichiarato', 'lucio-dalla'],
      ['altro', null],
      ['senza', null],
    ]);
  });

  it('nomi non latini con lo stesso residuo di un artista dichiarato: nessun link', () => {
    const linked = linkDeclaredArtists(
      [track('dichiarato', 'AC-DC'), track('cjk', '坂本龍一 & AC-DC'), track('numeri', '櫻坂46')],
      new Set(['ac-dc', '46']),
    );
    expect(linked.map((t) => [t.id, t.artistSlug])).toEqual([
      ['dichiarato', 'ac-dc'],
      ['cjk', null],
      ['numeri', null],
    ]);
  });

  it('indice non disponibile: nessun link', () => {
    expect(linkDeclaredArtists([track('1', 'Lucio Dalla')], null)[0]?.artistSlug).toBeNull();
  });
});

describe('shuffledCopy (Fisher–Yates)', () => {
  it('non cambia l’originale e tiene tutti gli elementi, una volta ciascuno', () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    const before = [...items];
    for (let round = 0; round < 10; round += 1) {
      const shuffled = shuffledCopy(items);
      expect(shuffled).toHaveLength(items.length);
      expect([...shuffled].sort((a, b) => a - b)).toEqual(before);
    }
    expect(items).toEqual(before);
  });

  it('con una sorgente casuale fissa l’ordine è deterministico; random ≈ 1 non esce dai bordi', () => {
    expect(shuffledCopy([1, 2, 3, 4], () => 0)).toEqual([2, 3, 4, 1]);
    expect(shuffledCopy([1, 2, 3], () => 0.999_999_999)).toEqual([1, 2, 3]);
    expect(shuffledCopy([1, 2, 3], () => 1)).toEqual([1, 2, 3]);
    expect(shuffledCopy([], () => 0)).toEqual([]);
  });
});
