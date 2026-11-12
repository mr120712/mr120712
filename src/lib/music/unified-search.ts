// @polsia:user-owned — fusione, ordinamento e deduplica dell'elenco misto della ricerca unificata.
// Funzioni pure (nessun accesso a rete o DB): la route interroga ogni fonte con le funzioni già
// esistenti e passa qui i risultati per costruire l'unico elenco ordinato. Testabili da sole.
import type { Podcast, RadioStation } from '@/lib/contracts/library';
import type { AudiusTrackSearchResult, YouTubeVideoSearchResult } from '@/lib/contracts/music';
import { UNIFIED_RANKED_LIMIT, type UnifiedResult } from '@/lib/contracts/unified-search';

/** Priorità della fonte: spareggio quando due voci hanno la stessa rilevanza (Audius riproducibile prima). */
const SOURCE_PRIORITY = { audius: 3, youtube: 2, radio: 1, podcast: 0 } as const;

/** minuscolo, senza accenti e con spazi normalizzati: base comune per rilevanza e deduplica. */
export function normalizeText(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Rilevanza di una voce rispetto alla query, sui suoi campi (titolo, artista…):
 * 100 uguale, 70 inizia con, 40 contiene, 0 altrimenti. Si prende il punteggio migliore fra i
 * campi, con un controllo aggiuntivo sul testo unito.
 */
export function relevanceScore(parts: readonly string[], query: string): number {
  const needle = normalizeText(query);
  if (!needle) return 0;
  let best = 0;
  for (const part of parts) {
    const hay = normalizeText(part);
    if (!hay) continue;
    if (hay === needle) best = Math.max(best, 100);
    else if (hay.startsWith(needle)) best = Math.max(best, 70);
    else if (hay.includes(needle)) best = Math.max(best, 40);
  }
  if (best < 40 && normalizeText(parts.join(' ')).includes(needle)) best = 40;
  return best;
}

// Parole di contorno nei titoli YouTube: non contano per decidere se è lo stesso brano.
const SONG_NOISE = new Set([
  'official',
  'video',
  'audio',
  'lyric',
  'lyrics',
  'lyricvideo',
  'hd',
  'hq',
  '4k',
  'mv',
  'feat',
  'ft',
  'featuring',
  'remaster',
  'remastered',
  'live',
  'prod',
  'topic',
  'vevo',
  'music',
  'song',
  'full',
  'version',
  'explicit',
  'visualizer',
  'clip',
  'ufficiale',
  'testo',
]);

/** Token significativi di un testo-brano: senza parentesi, punteggiatura e parole di contorno. */
export function songTokens(value: string): string[] {
  return normalizeText(value)
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((token) => token.length > 0 && !SONG_NOISE.has(token));
}

/**
 * Stesso brano su Audius e YouTube: ogni token significativo di "titolo + artista" Audius compare
 * nel "titolo + canale" YouTube (i titoli YouTube spesso contengono artista e titolo insieme).
 * Serve almeno 2 token Audius, per non fondere brani dal titolo troppo generico.
 */
export function isSameSong(
  audius: { title: string; artist: string },
  youtube: { title: string; channelTitle: string },
): boolean {
  const audiusTokens = new Set([...songTokens(audius.title), ...songTokens(audius.artist)]);
  if (audiusTokens.size < 2) return false;
  const youtubeTokens = new Set([
    ...songTokens(youtube.title),
    ...songTokens(youtube.channelTitle),
  ]);
  for (const token of audiusTokens) if (!youtubeTokens.has(token)) return false;
  return true;
}

export type UnifiedRankInput = {
  query: string;
  audiusTracks: readonly AudiusTrackSearchResult[];
  youtubeVideos: readonly YouTubeVideoSearchResult[];
  stations: readonly RadioStation[];
  podcasts: readonly Podcast[];
  limit?: number;
};

/**
 * Costruisce l'elenco misto: deduplica i brani presenti sia su Audius che su YouTube (la voce
 * Audius resta e porta il video come alternativa; il video non compare una seconda volta), assegna
 * la rilevanza, ordina per rilevanza e poi per priorità di fonte (ordine originale come ultimo
 * spareggio, così l'ordine interno di ciascuna fonte è preservato).
 */
export function rankUnifiedResults(input: UnifiedRankInput): UnifiedResult[] {
  const matchedVideoIds = new Set<string>();
  const audiusEntries = input.audiusTracks.map((track) => {
    const alternative = input.youtubeVideos.find(
      (video) =>
        !matchedVideoIds.has(video.videoId) &&
        isSameSong(
          { title: track.title, artist: track.artistName },
          { title: video.title, channelTitle: video.channelTitle },
        ),
    );
    if (alternative) matchedVideoIds.add(alternative.videoId);
    return { track, alternative: alternative ?? null };
  });

  const entries: Array<{ result: UnifiedResult; priority: number }> = [];

  for (const { track, alternative } of audiusEntries) {
    entries.push({
      priority: SOURCE_PRIORITY.audius,
      result: {
        kind: 'audius',
        key: `audius:${track.id}`,
        score: relevanceScore([track.title, track.artistName], input.query),
        track,
        youtubeAlternative: alternative,
      },
    });
  }

  for (const video of input.youtubeVideos) {
    if (matchedVideoIds.has(video.videoId)) continue; // già mostrato come alternativa di un brano Audius
    entries.push({
      priority: SOURCE_PRIORITY.youtube,
      result: {
        kind: 'youtube',
        key: `youtube:${video.videoId}`,
        score: relevanceScore([video.title, video.channelTitle], input.query),
        video,
      },
    });
  }

  for (const station of input.stations) {
    entries.push({
      priority: SOURCE_PRIORITY.radio,
      result: {
        kind: 'radio',
        key: `radio:${station.id}`,
        score: relevanceScore([station.name], input.query),
        station,
      },
    });
  }

  for (const podcast of input.podcasts) {
    entries.push({
      priority: SOURCE_PRIORITY.podcast,
      result: {
        kind: 'podcast',
        key: `podcast:${podcast.id}`,
        score: relevanceScore([podcast.title, podcast.author ?? ''], input.query),
        podcast,
      },
    });
  }

  // Punteggio composito intero (niente virgola mobile): rilevanza * 10 + priorità della fonte.
  return entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => {
      const composite =
        right.result.score * 10 + right.priority - (left.result.score * 10 + left.priority);
      return composite !== 0 ? composite : left.index - right.index;
    })
    .slice(0, input.limit ?? UNIFIED_RANKED_LIMIT)
    .map((entry) => entry.result);
}
