// @polsia:user-owned — fusione pura della ricerca unificata: normalizzazione, rilevanza,
// riconoscimento dello stesso brano fra Audius e YouTube, deduplica e ordinamento.
import { describe, expect, it } from 'vitest';
import type { Podcast, RadioStation } from '@/lib/contracts/library';
import type { AudiusTrackSearchResult, YouTubeVideoSearchResult } from '@/lib/contracts/music';
import {
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
