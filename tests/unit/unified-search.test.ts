// @polsia:user-owned — fusione pura della ricerca unificata: normalizzazione, rilevanza,
// riconoscimento dello stesso brano fra Audius e YouTube, deduplica e ordinamento (anche con i
// brani in evidenza del catalogo Solco).
import { describe, expect, it } from 'vitest';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import type { Podcast, RadioStation } from '@/lib/contracts/library';
import type { AudiusTrackSearchResult, YouTubeVideoSearchResult } from '@/lib/contracts/music';
import {
  featuredRelevance,
  isSameRecording,
  isSameSong,
  normalizeText,
  rankUnifiedResults,
  relevanceScore,
  songTokens,
} from '@/lib/music/unified-search';

function audiusTrack(
  id: string,
  title: string,
  artistName: string,
  overrides: Partial<AudiusTrackSearchResult> = {},
): AudiusTrackSearchResult {
  return {
    provider: 'audius',
    id,
    qualifiedId: `audius:${id}`,
    title,
    artistName,
    artistHandle: 'artista',
    artistId: `artist-${id}`,
    artistQualifiedId: `audius:artist-${id}`,
    artistUrl: 'https://audius.co/artista',
    trackUrl: `https://audius.co/artista/${id}`,
    artworkUrl: 'https://audius.co/images/cover.jpg',
    durationSeconds: 200,
    genre: null,
    mood: null,
    tags: null,
    releaseDate: null,
    license: null,
    licensorName: null,
    copyrightNotice: null,
    producerCopyrightNotice: null,
    attributionRemovalRequested: false,
    attributionComplete: true,
    playbackEligible: true,
    playbackReason: 'ready',
    ...overrides,
  } as AudiusTrackSearchResult;
}

function youtubeVideo(
  videoId: string,
  title: string,
  channelTitle: string,
): YouTubeVideoSearchResult {
  return {
    provider: 'youtube',
    videoId,
    title,
    channelTitle,
    channelId: 'UCabc123',
    description: null,
    publishedAt: null,
    thumbnailUrl: null,
  };
}

function station(id: string, name: string): RadioStation {
  return {
    id,
    name,
    artworkUrl: null,
    country: 'Italy',
    countryCode: 'IT',
    tags: [],
    codec: 'MP3',
    bitrate: 128,
    homepage: null,
    votes: 10,
  };
}

function podcast(id: string, title: string): Podcast {
  return { id, title, author: 'Autore', artworkUrl: null, genre: null };
}

function featured(id: string, title: string, artist: string | null): HomeTrack {
  return {
    id,
    title,
    artist,
    streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(id)}`,
    durationSeconds: 0,
    artworkUrl: null,
  };
}

describe('normalizzazione e token', () => {
  it('abbassa, toglie accenti e normalizza gli spazi', () => {
    expect(normalizeText('  CafÉ   del   Mar ')).toBe('cafe del mar');
  });

  it('scarta le parole di contorno dei titoli YouTube', () => {
    expect(songTokens('Khruangbin - August 10 (Official Audio)')).toEqual([
      'khruangbin',
      'august',
      '10',
    ]);
    expect(songTokens('Artista - Topic')).toEqual(['artista']);
  });
});

describe('relevanceScore', () => {
  it('100 esatto, 70 inizia con, 40 contiene, 0 altrimenti', () => {
    expect(relevanceScore(['Jazz'], 'jazz')).toBe(100);
    expect(relevanceScore(['Jazz Radio'], 'jazz')).toBe(70);
    expect(relevanceScore(['Smooth Jazz'], 'jazz')).toBe(40);
    expect(relevanceScore(['Ambient'], 'jazz')).toBe(0);
  });

  it('considera anche il testo unito di titolo e artista', () => {
    // Nessun singolo campo inizia con "mar sole", ma il testo unito lo contiene.
    expect(relevanceScore(['Mar', 'Sole'], 'mar sole')).toBe(40);
  });
});

describe('isSameSong', () => {
  it('riconosce lo stesso brano quando il titolo YouTube contiene titolo e artista', () => {
    expect(
      isSameSong(
        { title: 'August 10', artist: 'Khruangbin' },
        { title: 'Khruangbin - August 10 (Official Audio)', channelTitle: 'Khruangbin' },
      ),
    ).toBe(true);
  });

  it('usa anche il nome del canale (es. "Artista - Topic")', () => {
    expect(
      isSameSong(
        { title: 'August 10', artist: 'Khruangbin' },
        { title: 'August 10', channelTitle: 'Khruangbin - Topic' },
      ),
    ).toBe(true);
  });

  it('non fonde brani diversi', () => {
    expect(
      isSameSong(
        { title: 'August 10', artist: 'Khruangbin' },
        { title: 'Time (You and I)', channelTitle: 'Khruangbin' },
      ),
    ).toBe(false);
  });

  it('richiede almeno due token Audius, per evitare fusioni su titoli generici', () => {
    expect(
      isSameSong(
        { title: 'Live', artist: 'Official' },
        { title: 'Qualunque cosa', channelTitle: 'x' },
      ),
    ).toBe(false);
  });
});

describe('rankUnifiedResults', () => {
  it('deduplica lo stesso brano: la voce Audius porta il video come alternativa e il video non si ripete', () => {
    const results = rankUnifiedResults({
      query: 'august 10',
      audiusTracks: [audiusTrack('a1', 'August 10', 'Khruangbin')],
      youtubeVideos: [
        youtubeVideo('vvvvvvvvvvv', 'Khruangbin - August 10 (Official Audio)', 'Khruangbin'),
        youtubeVideo('wwwwwwwwwww', 'Altro brano diverso', 'Altro canale'),
      ],
      stations: [],
      podcasts: [],
    });

    const audiusEntry = results.find((item) => item.kind === 'audius');
    expect(audiusEntry?.kind).toBe('audius');
    if (audiusEntry?.kind === 'audius') {
      expect(audiusEntry.youtubeAlternative?.videoId).toBe('vvvvvvvvvvv');
    }
    // Il video deduplicato non compare come voce a sé; l'altro video sì.
    const videoIds = results.flatMap((item) =>
      item.kind === 'youtube' ? [item.video.videoId] : [],
    );
    expect(videoIds).toEqual(['wwwwwwwwwww']);
  });

  it('ordina per rilevanza e, a pari rilevanza, per priorità della fonte', () => {
    const results = rankUnifiedResults({
      query: 'luna',
      // Esatto su titolo radio (100) ma priorità più bassa.
      stations: [station('s1', 'Luna')],
      // Esatto su titolo Audius (100) e priorità più alta: deve stare prima della radio.
      audiusTracks: [audiusTrack('a1', 'Luna', 'Artista')],
      // "Contiene" (40): dopo gli esatti.
      youtubeVideos: [youtubeVideo('yyyyyyyyyyy', 'Mezza luna crescente', 'Canale')],
      // "Inizia con" (70): fra gli esatti e il "contiene".
      podcasts: [podcast('101', 'Luna di miele')],
    });

    expect(results.map((item) => item.key)).toEqual([
      'audius:a1', // 100, priorità 3
      'radio:s1', // 100, priorità 1
      'podcast:101', // 70
      'youtube:yyyyyyyyyyy', // 40
    ]);
  });

  it('rispetta il tetto e, a pari punteggio, tiene l’ordine interno della fonte', () => {
    const results = rankUnifiedResults({
      query: 'nulla-che-corrisponde',
      audiusTracks: [audiusTrack('a1', 'Primo', 'X'), audiusTrack('a2', 'Secondo', 'Y')],
      youtubeVideos: [],
      stations: [],
      podcasts: [],
      limit: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.key).toBe('audius:a1');
  });
});

describe('rankUnifiedResults con i brani in evidenza', () => {
  it('senza brani in evidenza l’elenco è identico a prima (nessuna voce featured)', () => {
    const input = {
      query: 'luna',
      audiusTracks: [audiusTrack('a1', 'Luna', 'Artista')],
      youtubeVideos: [youtubeVideo('yyyyyyyyyyy', 'Mezza luna', 'Canale')],
      stations: [station('s1', 'Luna')],
      podcasts: [],
    };
    const before = rankUnifiedResults(input);
    const after = rankUnifiedResults({ ...input, featuredTracks: [] });
    expect(after).toEqual(before);
    expect(after.some((item) => item.kind === 'featured')).toBe(false);
  });

  it('a pari rilevanza il catalogo Solco viene prima di ogni altra fonte', () => {
    const results = rankUnifiedResults({
      query: 'luna',
      featuredTracks: [featured('Luna.mp3', 'Luna', null)],
      audiusTracks: [audiusTrack('a1', 'Luna', 'Altro artista')],
      youtubeVideos: [],
      stations: [station('s1', 'Luna')],
      podcasts: [],
    });
    expect(results.map((item) => item.key)).toEqual([
      'featured:Luna.mp3', // 100, priorità 4
      'audius:a1', // 100, priorità 3
      'radio:s1', // 100, priorità 1
    ]);
    const first = results[0];
    expect(first?.kind).toBe('featured');
    if (first?.kind === 'featured') expect(first.score).toBe(100);
  });

  it('la rilevanza conta più della fonte: un brano in evidenza meno pertinente scende', () => {
    const results = rankUnifiedResults({
      query: 'luna',
      featuredTracks: [featured('Notte - Luna piena.mp3', 'Luna piena', 'Notte')],
      audiusTracks: [audiusTrack('a1', 'Luna', 'Artista')],
      youtubeVideos: [],
      stations: [],
      podcasts: [],
    });
    expect(results.map((item) => item.key)).toEqual([
      'audius:a1', // 100
      'featured:Notte - Luna piena.mp3', // 70
    ]);
  });

  it('deduplica: lo stesso brano su Audius non si ripete e il video resta come alternativa', () => {
    const song = featured('Pop/Khruangbin - August 10.mp3', 'August 10', 'Khruangbin');
    const results = rankUnifiedResults({
      query: 'august 10',
      featuredTracks: [song],
      audiusTracks: [
        audiusTrack('a1', 'August 10', 'Khruangbin'),
        audiusTrack('a2', 'August 10 (Remix)', 'Altro DJ'),
      ],
      youtubeVideos: [
        youtubeVideo('vvvvvvvvvvv', 'Khruangbin - August 10 (Official Audio)', 'Khruangbin'),
        youtubeVideo('zzzzzzzzzzz', 'Tutorial chitarra', 'Lezioni'),
      ],
      stations: [],
      podcasts: [],
    });

    const keys = results.map((item) => item.key);
    // Il brano Audius identico è assorbito; quello diverso (altro artista) resta.
    expect(keys).not.toContain('audius:a1');
    expect(keys).toContain('audius:a2');
    // Il video dello stesso brano non è una riga a sé: è l'alternativa del brano in evidenza.
    expect(keys).not.toContain('youtube:vvvvvvvvvvv');
    const entry = results.find((item) => item.kind === 'featured');
    expect(entry?.kind === 'featured' && entry.youtubeAlternative?.videoId).toBe('vvvvvvvvvvv');
    // Prima voce: il catalogo Solco.
    expect(keys[0]).toBe('featured:Pop/Khruangbin - August 10.mp3');
  });

  it('un video già alternativa del brano in evidenza non diventa alternativa di un brano Audius', () => {
    const results = rankUnifiedResults({
      query: 'august',
      featuredTracks: [featured('a.mp3', 'August 10', 'Khruangbin')],
      // Token diversi dal brano in evidenza (non è lo stesso brano, resta), ma tutti presenti nel
      // video: senza il brano in evidenza ne diventerebbe l'alternativa.
      audiusTracks: [audiusTrack('a1', 'August', 'Khruangbin')],
      youtubeVideos: [
        youtubeVideo('vvvvvvvvvvv', 'Khruangbin - August 10 (Official Audio)', 'Khruangbin'),
      ],
      stations: [],
      podcasts: [],
    });
    const audius = results.find((item) => item.kind === 'audius');
    expect(audius?.kind === 'audius' && audius.youtubeAlternative).toBeNull();
    expect(results.filter((item) => item.kind === 'youtube')).toHaveLength(0);
    const entry = results.find((item) => item.kind === 'featured');
    expect(entry?.kind === 'featured' && entry.youtubeAlternative?.videoId).toBe('vvvvvvvvvvv');
    // Controprova: senza il brano in evidenza il video va al brano Audius.
    const without = rankUnifiedResults({
      query: 'august',
      audiusTracks: [audiusTrack('a1', 'August', 'Khruangbin')],
      youtubeVideos: [
        youtubeVideo('vvvvvvvvvvv', 'Khruangbin - August 10 (Official Audio)', 'Khruangbin'),
      ],
      stations: [],
      podcasts: [],
    });
    expect(without[0]?.kind === 'audius' && without[0].youtubeAlternative?.videoId).toBe(
      'vvvvvvvvvvv',
    );
  });

  it('"Artista Titolo" e "Artista - Titolo": il brano in evidenza ha piena rilevanza ed è primo', () => {
    const song = featured(
      'Rock italiano/Vasco Rossi - Albachiara.mp3',
      'Albachiara',
      'Vasco Rossi',
    );
    for (const query of ['Vasco Rossi Albachiara', 'Vasco Rossi - Albachiara']) {
      const results = rankUnifiedResults({
        query,
        featuredTracks: [song],
        audiusTracks: [audiusTrack('a1', 'Albachiara (cover)', 'Band di paese')],
        youtubeVideos: [],
        stations: [station('s1', 'Radio Vasco Rossi Albachiara')],
        podcasts: [],
      });
      const first = results[0];
      expect(first?.key).toBe(`featured:${song.id}`);
      if (first?.kind === 'featured') expect(first.score).toBe(100);
    }
    // Stessa rilevanza del filtro della fonte.
    expect(featuredRelevance(song, 'Vasco Rossi Albachiara')).toBe(100);
    expect(featuredRelevance(featured('Pioggia.mp3', 'Pioggia', null), 'Solco Pioggia')).toBe(100);
    // Le altre fonti non cambiano: "Artista Titolo" su Audius resta come prima.
    expect(relevanceScore(['Albachiara', 'Vasco Rossi'], 'Vasco Rossi Albachiara')).toBe(0);
  });

  it('brano in evidenza senza artista: il video di un altro artista con lo stesso titolo resta una riga a sé', () => {
    const song = featured('Notte stellata.mp3', 'Notte stellata', null);
    const results = rankUnifiedResults({
      query: 'notte stellata',
      featuredTracks: [song],
      audiusTracks: [],
      youtubeVideos: [
        youtubeVideo('vvvvvvvvvvv', 'Il Volo - Notte stellata (Official Video)', 'IlVoloVEVO'),
      ],
      stations: [],
      podcasts: [],
    });
    const entry = results.find((item) => item.kind === 'featured');
    expect(entry?.kind === 'featured' && entry.youtubeAlternative).toBeNull();
    expect(results.map((item) => item.key)).toEqual([
      'featured:Notte stellata.mp3',
      'youtube:vvvvvvvvvvv',
    ]);

    // Né assorbe un brano Audius con gli stessi token del solo titolo.
    const withAudius = rankUnifiedResults({
      query: 'notte stellata',
      featuredTracks: [song],
      audiusTracks: [audiusTrack('a1', 'Stellata', 'Notte')],
      youtubeVideos: [],
      stations: [],
      podcasts: [],
    });
    expect(withAudius.map((item) => item.key)).toContain('audius:a1');
  });

  it('isSameRecording: stessi token in entrambe le direzioni, almeno due', () => {
    expect(
      isSameRecording(
        { title: 'August 10', artist: 'Khruangbin' },
        { title: 'August 10 (Remastered)', artist: 'Khruangbin' },
      ),
    ).toBe(true);
    expect(
      isSameRecording(
        { title: 'August 10', artist: 'Khruangbin' },
        { title: 'August 10', artist: 'Khruangbin & Leon Bridges' },
      ),
    ).toBe(false);
    // Un solo token: troppo generico per fondere.
    expect(isSameRecording({ title: 'Intro', artist: '' }, { title: 'Intro', artist: '' })).toBe(
      false,
    );
  });
});
