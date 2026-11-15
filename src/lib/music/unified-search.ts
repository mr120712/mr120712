// @polsia:user-owned — fusione, ordinamento e deduplica dell'elenco misto della ricerca unificata.
// Funzioni pure (nessun accesso a rete o DB): la route interroga ogni fonte con le funzioni già
// esistenti e passa qui i risultati per costruire l'unico elenco ordinato. Testabili da sole.
import type { AudioComTrack } from '@/lib/contracts/audiocom';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import type { Podcast, RadioStation } from '@/lib/contracts/library';
import type { AudiusTrackSearchResult, YouTubeVideoSearchResult } from '@/lib/contracts/music';
import { UNIFIED_RANKED_LIMIT, type UnifiedResult } from '@/lib/contracts/unified-search';
import { isAudioComPlayable } from '@/lib/music/audiocom-license';

/**
 * Priorità della fonte: spareggio quando due voci hanno la stessa rilevanza. Prima il catalogo di
 * Solco (brani in evidenza con diritti dichiarati), poi Audius riproducibile, poi i brani di
 * audio.com riproducibili in Solco (licenza CC ammessa), YouTube, i brani di audio.com che si
 * ascoltano solo nel player ufficiale di audio.com, radio e podcast. Resta sotto 10: il punteggio
 * composito è rilevanza * 10 + priorità (l'ordine relativo delle fonti di prima non cambia).
 */
const SOURCE_PRIORITY = {
  featured: 6,
  audius: 5,
  audiocomPlayable: 4,
  youtube: 3,
  audiocomEmbed: 2,
  radio: 1,
  podcast: 0,
} as const;

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

/** Artista mostrato per un brano in evidenza senza artista nel nome del file (come nel player). */
export const FEATURED_DEFAULT_ARTIST = 'Solco';

/** "Artista - Titolo" (trattino, en o em dash fra spazi, come nei nomi dei file) → "Artista Titolo". */
function withoutSeparators(value: string): string {
  return value.replace(/\s+[-–—]\s+/g, ' ');
}

/**
 * Rilevanza di un brano in evidenza: titolo e artista come le altre fonti, più "Artista Titolo"
 * (anche scritto "Artista - Titolo", la convenzione dei nomi dei file; è anche la query dei link di
 * condivisione del player, che senza artista usa "Solco"). La forma "Artista Titolo" è valutata da
 * sola, così le parti non si mescolano. La usano SIA il filtro della fonte sia l'ordinamento, che
 * quindi concordano. Non cambia relevanceScore delle altre fonti.
 */
export function featuredRelevance(
  track: { title: string; artist: string | null },
  query: string,
): number {
  const credited = track.artist?.trim() || FEATURED_DEFAULT_ARTIST;
  return Math.max(
    relevanceScore([track.title, track.artist ?? ''], query),
    artistTitleScore(credited, track.title, query),
  );
}

/**
 * Come featuredRelevance ma SENZA artista predefinito, per i brani salvati nella Libreria: titolo e
 * artista, più "Artista Titolo" (anche "Artista - Titolo"), la query dei link di condivisione di un
 * brano (songShareUrl). Senza artista conta solo il titolo.
 */
export function trackRelevance(
  track: { title: string; artist: string | null },
  query: string,
): number {
  const byFields = relevanceScore([track.title, track.artist ?? ''], query);
  const artist = track.artist?.trim();
  return artist ? Math.max(byFields, artistTitleScore(artist, track.title, query)) : byFields;
}

/** La forma "Artista Titolo" valutata da sola, così le parti non si mescolano. */
function artistTitleScore(artist: string, title: string, query: string): number {
  return relevanceScore([withoutSeparators(`${artist} ${title}`)], withoutSeparators(query));
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

/**
 * Stesso brano fra un brano in evidenza e un brano Audius: entrambi hanno titolo e artista puliti
 * (niente "Official Video" o nome del canale), quindi i token significativi devono coincidere in
 * tutte e due le direzioni. Servono almeno 2 token, come per Audius/YouTube.
 */
export function isSameRecording(
  left: { title: string; artist: string },
  right: { title: string; artist: string },
): boolean {
  const leftTokens = new Set([...songTokens(left.title), ...songTokens(left.artist)]);
  if (leftTokens.size < 2) return false;
  const rightTokens = new Set([...songTokens(right.title), ...songTokens(right.artist)]);
  if (rightTokens.size !== leftTokens.size) return false;
  for (const token of leftTokens) if (!rightTokens.has(token)) return false;
  return true;
}

export type UnifiedRankInput = {
  query: string;
  /** Brani in evidenza già filtrati per diritti dichiarati (assenti per chi non li chiede). */
  featuredTracks?: readonly HomeTrack[];
  audiusTracks: readonly AudiusTrackSearchResult[];
  /** Brani di audio.com (assenti per chi non li chiede). */
  audiocomTracks?: readonly AudioComTrack[];
  youtubeVideos: readonly YouTubeVideoSearchResult[];
  stations: readonly RadioStation[];
  podcasts: readonly Podcast[];
  limit?: number;
};

/**
 * Costruisce l'elenco misto: deduplica i brani presenti in più fonti, assegna la rilevanza, ordina
 * per rilevanza e poi per priorità di fonte (ordine originale come ultimo spareggio, così l'ordine
 * interno di ciascuna fonte è preservato). Deduplica, dalla fonte più importante:
 * - un brano in evidenza resta e porta come alternativa lo stesso brano su YouTube; lo stesso
 *   brano su Audius non compare una seconda volta (solo se il brano in evidenza ha un artista);
 * - un brano Audius resta e porta il video come alternativa; il video non compare una seconda volta;
 * - un brano di audio.com uguale a un brano in evidenza (con artista) o a un brano Audius
 *   riproducibile non compare (resta la fonte più importante); altrimenti resta e porta come
 *   alternativa lo stesso brano su YouTube.
 * I doppioni restano comunque nelle sezioni per fonte (`sources`).
 */
export function rankUnifiedResults(input: UnifiedRankInput): UnifiedResult[] {
  const matchedVideoIds = new Set<string>();
  const findAlternative = (song: { title: string; artist: string }) => {
    const alternative = input.youtubeVideos.find(
      (video) =>
        !matchedVideoIds.has(video.videoId) &&
        isSameSong(song, { title: video.title, channelTitle: video.channelTitle }),
    );
    if (alternative) matchedVideoIds.add(alternative.videoId);
    return alternative ?? null;
  };

  // Prima il catalogo Solco: assorbe il video e il brano Audius dello stesso brano.
  const absorbedAudiusIds = new Set<string>();
  const featuredEntries = (input.featuredTracks ?? []).map((track) => {
    // Senza artista il solo titolo non basta a dire "stesso brano" (il video di un altro artista
    // con lo stesso titolo verrebbe assorbito e nascosto): nessuna alternativa, nessun doppione.
    if (!track.artist?.trim()) return { track, alternative: null };
    const song = { title: track.title, artist: track.artist };
    const twin = input.audiusTracks.find(
      (audius) =>
        !absorbedAudiusIds.has(audius.id) &&
        isSameRecording(song, { title: audius.title, artist: audius.artistName }),
    );
    if (twin) absorbedAudiusIds.add(twin.id);
    return { track, alternative: findAlternative(song) };
  });

  const audiusEntries = input.audiusTracks
    .filter((track) => !absorbedAudiusIds.has(track.id))
    .map((track) => ({
      track,
      alternative: findAlternative({ title: track.title, artist: track.artistName }),
    }));

  // audio.com dopo il catalogo Solco e Audius: lo stesso brano già presente là non si ripete. Conta
  // solo un brano Audius che si può ascoltare: se il gemello Audius non è riproducibile, la voce di
  // audio.com resta (altrimenti per quel brano rimarrebbe solo una riga senza ascolto).
  const knownRecordings = [
    ...featuredEntries
      .filter(({ track }) => Boolean(track.artist?.trim()))
      .map(({ track }) => ({ title: track.title, artist: track.artist ?? '' })),
    ...audiusEntries
      .filter(({ track }) => track.playbackEligible)
      .map(({ track }) => ({ title: track.title, artist: track.artistName })),
  ];
  const seenAudioComIds = new Set<string>();
  const audiocomEntries = (input.audiocomTracks ?? []).flatMap((track) => {
    if (seenAudioComIds.has(track.id)) return [];
    seenAudioComIds.add(track.id);
    const song = { title: track.title, artist: track.authorName };
    if (knownRecordings.some((known) => isSameRecording(known, song))) return [];
    return [{ track, alternative: findAlternative(song) }];
  });

  const entries: Array<{ result: UnifiedResult; priority: number }> = [];

  for (const { track, alternative } of featuredEntries) {
    entries.push({
      priority: SOURCE_PRIORITY.featured,
      result: {
        kind: 'featured',
        key: `featured:${track.id}`,
        score: featuredRelevance(track, input.query),
        track,
        youtubeAlternative: alternative,
      },
    });
  }

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

  for (const { track, alternative } of audiocomEntries) {
    entries.push({
      priority: isAudioComPlayable(track)
        ? SOURCE_PRIORITY.audiocomPlayable
        : SOURCE_PRIORITY.audiocomEmbed,
      result: {
        kind: 'audiocom',
        key: `audiocom:${track.id}`,
        // Stessa scala di Audius e YouTube (relevanceScore): niente bonus «Artista Titolo» che
        // metterebbe una voce solo-embed davanti a un brano Audius riproducibile.
        score: relevanceScore([track.title, track.authorName], input.query),
        track,
        youtubeAlternative: alternative,
      },
    });
  }

  for (const video of input.youtubeVideos) {
    if (matchedVideoIds.has(video.videoId)) continue; // già mostrato come alternativa di un brano
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
