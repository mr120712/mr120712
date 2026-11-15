// @polsia:user-owned — «Potrebbe piacerti», funzioni pure: profilo dai SOLI dati dell'utente
// (niente voci YouTube, brani caricati o file locali), esclusioni (già ascoltati, già in Libreria,
// «Non mi interessa»), tetto di 2 brani per artista, motivi in italiano, partenza a freddo, ordine
// fisso per giorno e pagine di «Altri consigli».
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  RECOMMENDATION_PAGE_SIZE,
  type RecommendationItem,
  RecommendationsResponseSchema,
} from '@/lib/contracts/recommendations';
import {
  buildTasteProfile,
  capCandidates,
  dailySeed,
  eligibleEntries,
  isColdStart,
  mergeCandidates,
  normalizeArtistKey,
  type PoolEntry,
  type PoolSource,
  paginate,
  rankingContext,
  reasonFor,
  romeDay,
  selectPage,
  toAudiusGenre,
} from '@/lib/music/recommendations';

const NOW = new Date('2026-11-15T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function audiusItem(id: string, artistName: string, playable = true): RecommendationItem {
  return {
    kind: 'audius',
    id,
    qualifiedId: `audius:${id}`,
    title: `Brano ${id}`,
    artistName,
    artistUrl: `https://audius.co/${normalizeArtistKey(artistName).replace(/ /g, '') || 'x'}`,
    trackUrl: `https://audius.co/artist/brano-${id}`,
    artworkUrl: `https://audius.example/${id}.jpg`,
    durationSeconds: 180,
    license: null,
    licensorName: artistName,
    copyrightNotice: null,
    attributionRemovalRequested: false,
    // The type says true; a corrupt/stale entry is simulated with a cast below.
    playbackEligible: playable as true,
    playbackReason: 'ready',
    genre: 'Electronic',
    reason: reasonFor('trending'),
  };
}

function entry(
  id: string,
  artistName: string,
  source: PoolSource = 'trending',
  rank = 0,
  playable = true,
): PoolEntry {
  return {
    item: {
      ...audiusItem(id, artistName, playable),
      reason: reasonFor(source, { artist: artistName }),
    },
    source,
    rank,
    genre: 'Electronic',
    mood: null,
    alsoIn: [],
  };
}

function songEntry(hex: string, artistName: string, title: string): PoolEntry {
  return {
    item: {
      kind: 'song',
      qualifiedId: `song:${hex}`,
      title,
      artistName,
      reason: reasonFor('ai', { artist: 'Seed' }),
    },
    source: 'ai',
    rank: 0,
    genre: null,
    mood: null,
    alsoIn: [],
  };
}

const context = (seed = 1) => rankingContext(null, [], [], seed);

describe('normalizzazione e generi', () => {
  it('stesso artista in grafie diverse', () => {
    expect(normalizeArtistKey('Beyoncé!')).toBe(normalizeArtistKey('BEYONCE'));
    expect(normalizeArtistKey('  Daft   Punk ')).toBe('daft punk');
  });

  it('porta i generi liberi del catalogo e del diario ai generi Audius', () => {
    expect(toAudiusGenre('Electronic')).toBe('Electronic');
    expect(toAudiusGenre('hip hop')).toBe('Hip-Hop/Rap');
    expect(toAudiusGenre('Rap italiano')).toBe('Hip-Hop/Rap');
    expect(toAudiusGenre('Deep House')).toBe('Deep House');
    expect(toAudiusGenre('house music')).toBe('House');
    expect(toAudiusGenre('Elettronica')).toBe('Electronic');
    expect(toAudiusGenre('Musica classica')).toBe('Classical');
    expect(toAudiusGenre('Indie rock')).toBe('Alternative');
    expect(toAudiusGenre('Cantautorato')).toBe('Acoustic');
    expect(toAudiusGenre('Pop')).toBe('Pop');
    expect(toAudiusGenre('Polka')).toBeNull();
    expect(toAudiusGenre(null)).toBeNull();
  });
});

describe('profilo di gusto', () => {
  it('pesa conteggio e recenza, ignora YouTube, brani caricati, locali e ascolti oltre 60 giorni', () => {
    const profile = buildTasteProfile({
      now: NOW,
      history: [
        // 10 ascolti ieri pesano più di 3 di un mese fa, che pesano più di 1 di due giorni fa.
        {
          qualifiedId: 'audius:a1',
          artistName: 'Alfa',
          playCount: 10,
          lastPlayedAt: new Date(NOW.getTime() - DAY),
          handle: 'alfa',
        },
        {
          qualifiedId: 'audius:b1',
          artistName: 'Beta',
          playCount: 3,
          lastPlayedAt: new Date(NOW.getTime() - 30 * DAY),
          handle: null,
        },
        {
          qualifiedId: 'jamendo:77',
          artistName: 'Gamma',
          playCount: 1,
          lastPlayedAt: new Date(NOW.getTime() - 2 * DAY),
          handle: null,
        },
        // Mai semi né esclusioni gestite qui: YouTube, «In evidenza», file locali.
        {
          qualifiedId: 'youtube:abcdefghijk',
          artistName: 'Canale YT',
          playCount: 50,
          lastPlayedAt: NOW,
          handle: null,
        },
        {
          qualifiedId: 'upload:clxfeaturedtrack0000001',
          artistName: 'In evidenza',
          playCount: 50,
          lastPlayedAt: NOW,
          handle: null,
        },
        {
          qualifiedId: 'local:abc',
          artistName: 'File locale',
          playCount: 50,
          lastPlayedAt: NOW,
          handle: null,
        },
        // Troppo vecchio.
        {
          qualifiedId: 'audius:old',
          artistName: 'Vecchio',
          playCount: 10,
          lastPlayedAt: new Date(NOW.getTime() - 90 * DAY),
          handle: null,
        },
      ],
      library: [],
      diary: [],
    });
    expect(profile.artists.map((artist) => artist.name)).toEqual(['Alfa', 'Beta', 'Gamma']);
    expect(profile.artists[0]?.handle).toBe('alfa');
    expect(profile.excluded).toEqual(new Set(['audius:a1', 'audius:b1', 'jamendo:77']));
    expect(isColdStart(profile)).toBe(false);
  });

  it('Libreria: Preferiti pesano più delle playlist; un brano Spotify (peso 0) esclude ma non entra nel gusto', () => {
    const profile = buildTasteProfile({
      now: NOW,
      history: [],
      library: [
        { qualifiedId: 'audius:f1', artistName: 'Preferito', weight: 3 },
        {
          qualifiedId: 'song:0123456789abcdef0123456789abcdef',
          artistName: 'Playlist',
          weight: 1.5,
        },
        { qualifiedId: 'song:fedcba9876543210fedcba9876543210', artistName: null, weight: 0 },
        { qualifiedId: 'youtube:abcdefghijk', artistName: 'Video', weight: 3 },
      ],
      diary: [],
    });
    expect(profile.artists.map((artist) => [artist.name, artist.weight])).toEqual([
      ['Preferito', 3],
      ['Playlist', 1.5],
    ]);
    expect(profile.excluded.has('song:fedcba9876543210fedcba9876543210')).toBe(true);
    expect(profile.excluded.has('youtube:abcdefghijk')).toBe(false);
  });

  it('diario: solo album votati 4 o 5, con i generi portati ad Audius', () => {
    const profile = buildTasteProfile({
      now: NOW,
      history: [],
      library: [],
      diary: [
        { artistName: 'Jazzista', genre: 'Jazz', rating: 5 },
        { artistName: 'Bocciato', genre: 'Pop', rating: 2 },
      ],
    });
    expect(profile.artists.map((artist) => artist.name)).toEqual(['Jazzista']);
    expect(profile.diaryGenres).toEqual([{ genre: 'Jazz', weight: 3 }]);
  });

  it('partenza a freddo: niente artisti né generi', () => {
    const profile = buildTasteProfile({ now: NOW, history: [], library: [], diary: [] });
    expect(isColdStart(profile)).toBe(true);
  });
});

describe('motivi', () => {
  it('brevi e in italiano', () => {
    expect(reasonFor('artist', { artist: 'Alfa' }).text).toBe('Perché hai ascoltato Alfa');
    // Brani popolari nel genere dell'artista: nessuna somiglianza promessa che non sia verificata.
    expect(reasonFor('similar', { artist: 'Alfa' }).text).toBe('Popolare nel genere di Alfa');
    expect(reasonFor('similar', { artist: 'Alfa' }).text).not.toContain('Simile');
    expect(reasonFor('genre', { genre: 'Lo-Fi' }).text).toBe('Popolare nel genere Lo-Fi');
    expect(reasonFor('community').text).toBe('Piace alla community');
    expect(reasonFor('trending').text).toBe('Di tendenza su Audius');
    expect(reasonFor('ai', { artist: 'Alfa' }).text).toBe('Suggerito dall’AI, simile a Alfa');
    expect(reasonFor('artist', { artist: 'x'.repeat(200) }).text.length).toBeLessThanOrEqual(120);
  });
});

describe('candidati ed esclusioni', () => {
  it('stesso brano da più fonti: resta il motivo più forte, le altre fonti contano come conferma', () => {
    const merged = mergeCandidates([
      [entry('1', 'Alfa', 'trending')],
      [entry('1', 'Alfa', 'artist')],
      [entry('1', 'Alfa', 'community')],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe('artist');
    expect(merged[0]?.item.reason.text).toBe('Perché hai ascoltato Alfa');
    expect(merged[0]?.alsoIn).toEqual(['community', 'trending']);
  });

  it('esclude già ascoltati, già in Libreria, nascosti, non riproducibili, caricati e locali', () => {
    const corrupt = (qualifiedId: string): PoolEntry => {
      const base = entry('x', 'Zeta');
      return { ...base, item: { ...base.item, qualifiedId } as RecommendationItem };
    };
    const pool = [
      entry('keep', 'Alfa'),
      entry('played', 'Beta'),
      entry('hidden', 'Gamma'),
      entry('blocked', 'Delta', 'trending', 0, false),
      corrupt('upload:clxfeaturedtrack0000001'),
      corrupt('local:abc'),
      corrupt('youtube:abcdefghijk'),
      entry('keep', 'Alfa'),
    ];
    const kept = eligibleEntries(pool, {
      excluded: new Set(['audius:played']),
      hidden: new Set(['audius:hidden']),
    });
    expect(kept.map((item) => item.item.qualifiedId)).toEqual(['audius:keep']);
  });
});

describe('taglio dei candidati', () => {
  const list = (prefix: string, count: number, source: PoolSource) =>
    Array.from({ length: count }, (_, index) =>
      entry(`${prefix}${index}`, `${prefix} ${index}`, source, index),
    );

  it('artisti e generi non tolgono il posto a community e tendenze', () => {
    const personal = [...list('a', 40, 'artist'), ...list('s', 80, 'similar')];
    const general = [...list('c', 8, 'community'), ...list('t', 20, 'trending')];
    const kept = capCandidates([...personal, ...general], 120);
    expect(kept).toHaveLength(120);
    const count = (source: PoolSource) => kept.filter((item) => item.source === source).length;
    expect(count('community')).toBe(8);
    expect(count('trending')).toBe(12);
    expect(count('artist') + count('similar')).toBe(100);
    // L'ordine relativo resta quello di partenza (le fonti personali per prime).
    expect(kept[0]?.item.qualifiedId).toBe('audius:a0');
  });

  it('posti personali non usati: tornano a community e tendenze', () => {
    const kept = capCandidates([...list('a', 5, 'artist'), ...list('t', 40, 'trending')], 30);
    expect(kept.filter((item) => item.source === 'artist')).toHaveLength(5);
    expect(kept.filter((item) => item.source === 'trending')).toHaveLength(25);
  });

  it('sotto il limite non toglie nulla', () => {
    const all = [...list('a', 3, 'artist'), ...list('c', 2, 'community')];
    expect(capCandidates(all, 120)).toEqual(all);
  });
});

describe('varietà, ordine del giorno e pagine', () => {
  const pool = Array.from({ length: 40 }, (_, index) =>
    entry(String(index), `Artista ${index % 12}`, index % 3 === 0 ? 'artist' : 'genre', index),
  );

  it('al massimo 2 brani per artista in ogni pagina, pagine da 16', () => {
    const pages = paginate(pool, RECOMMENDATION_PAGE_SIZE);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(RECOMMENDATION_PAGE_SIZE);
      const counts = new Map<string, number>();
      for (const item of page)
        counts.set(item.item.artistName, (counts.get(item.item.artistName) ?? 0) + 1);
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    }
  });

  it('un artista solo con tanti brani: l’ultima pagina troppo corta viene lasciata', () => {
    const single = Array.from({ length: 10 }, (_, index) => entry(String(index), 'Solo'));
    const pages = paginate(single, RECOMMENDATION_PAGE_SIZE);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(2);
  });

  it('stesso utente e stesso giorno → stessi brani nello stesso ordine; un altro giorno cambia', () => {
    const seed = dailySeed('user-1', '2026-11-15');
    const first = selectPage(pool, context(seed), 0, RECOMMENDATION_PAGE_SIZE);
    const again = selectPage([...pool].reverse(), context(seed), 0, RECOMMENDATION_PAGE_SIZE);
    expect(again.items.map((item) => item.qualifiedId)).toEqual(
      first.items.map((item) => item.qualifiedId),
    );
    const otherDays = ['2026-11-16', '2026-11-17', '2026-11-18'].map((day) =>
      selectPage(pool, context(dailySeed('user-1', day)), 0, RECOMMENDATION_PAGE_SIZE)
        .items.map((item) => item.qualifiedId)
        .join(),
    );
    expect(
      otherDays.some((order) => order !== first.items.map((item) => item.qualifiedId).join()),
    ).toBe(true);
  });

  it('«Altri consigli»: pagine diverse, poi un giro rimescolato; risposta valida per il contratto', () => {
    const seed = dailySeed('user-1', '2026-11-15');
    const page0 = selectPage(pool, context(seed), 0, RECOMMENDATION_PAGE_SIZE);
    const page1 = selectPage(pool, context(seed), 1, RECOMMENDATION_PAGE_SIZE);
    expect(page0.nextPage).toBe(1);
    const shown = new Set(page0.items.map((item) => item.qualifiedId));
    expect(page1.items.every((item) => !shown.has(item.qualifiedId))).toBe(true);
    const later = selectPage(pool, context(seed), 7, RECOMMENDATION_PAGE_SIZE);
    expect(later.items.length).toBeGreaterThan(0);
    expect(RecommendationsResponseSchema.safeParse({ mode: 'personal', ...page0 }).success).toBe(
      true,
    );
  });

  it('nulla da mostrare oltre la pagina: niente «Altri consigli»', () => {
    const small = [entry('1', 'A'), entry('2', 'B'), entry('3', 'C')];
    expect(selectPage(small, context(), 0, RECOMMENDATION_PAGE_SIZE).nextPage).toBeNull();
    expect(selectPage([], context(), 0, RECOMMENDATION_PAGE_SIZE)).toEqual({
      items: [],
      page: 0,
      nextPage: null,
    });
  });

  it('affinità: a parità di fonte, gli artisti del profilo e i loro generi vengono prima', () => {
    const profile = buildTasteProfile({
      now: NOW,
      history: [
        {
          qualifiedId: 'audius:h1',
          artistName: 'Amato',
          playCount: 10,
          lastPlayedAt: NOW,
          handle: null,
        },
      ],
      library: [],
      diary: [],
    });
    const ranked = selectPage(
      [entry('1', 'Sconosciuto', 'genre'), entry('2', 'Amato', 'genre')],
      rankingContext(profile, [], [], 1),
      0,
      RECOMMENDATION_PAGE_SIZE,
    );
    expect(ranked.items[0]?.artistName).toBe('Amato');
  });

  it('i brani "song" (AI) stanno nello stesso ordinamento e nello stesso tetto per artista', () => {
    const mixed = [
      songEntry('a'.repeat(32), 'Uno', 'Primo'),
      songEntry('b'.repeat(32), 'Uno', 'Secondo'),
      songEntry('c'.repeat(32), 'Uno', 'Terzo'),
      entry('1', 'Due'),
    ];
    const page = selectPage(mixed, context(), 0, RECOMMENDATION_PAGE_SIZE);
    expect(page.items.filter((item) => item.artistName === 'Uno')).toHaveLength(2);
  });
});

describe('giorno italiano', () => {
  it('cambia a mezzanotte ora di Roma', () => {
    expect(romeDay(new Date('2026-11-15T22:30:00.000Z'))).toBe('2026-11-15');
    expect(romeDay(new Date('2026-11-15T23:30:00.000Z'))).toBe('2026-11-16');
  });
});
