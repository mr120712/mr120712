// @polsia:user-owned — trova lo stesso brano di un video YouTube su Audius o Jamendo, dove
// l'ascolto in background è consentito. Solo corrispondenze sicure: meglio "non trovato" che
// un brano sbagliato.

const NOISE =
  /\b(official|ufficiale|video|videoclip|music|musica|audio|lyrics?|testo|visuali[sz]er|hd|4k|hq|remaster(ed)?|live|clip|prod\.?|ft\.?|feat\.?|featuring|vevo|topic|records?|tv|channel)\b/gi;

/** Minuscolo, senza accenti, senza parentesi e parole di contorno ("Official Video", "VEVO"…). */
export function normalizeMusicText(value: string) {
  return (
    value
      .slice(0, 400)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
      .replace(NOISE, ' ')
      // Unicode letters and digits: Cyrillic, Greek, CJK, Arabic… titles keep their words.
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function wordsOf(text: string) {
  // One-letter Latin words are noise ("a", "x"); one non-Latin character can be a whole word.
  return text
    .split(' ')
    .filter((word) => word.length > 1 || /[^\p{Script=Latin}\p{N}]/u.test(word));
}

function tokens(value: string) {
  return wordsOf(normalizeMusicText(value));
}

/** Like tokens(), but keeps noise words: for titles made only of them ("Music", "Live"). */
function plainTokens(value: string) {
  return wordsOf(
    value
      .slice(0, 400)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** Artista e titolo da un video: "Artista - Titolo (Official Video)" oppure il canale. */
export function parseVideoTitle(title: string, channelTitle: string) {
  const parts = title.split(/\s[-–—|]\s/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' ').trim() };
  }
  return { artist: channelTitle.replace(/vevo$|\s*-\s*topic$/i, '').trim(), title: title.trim() };
}

/** Testo da cercare su Audius e Jamendo. */
export function backgroundSearchQuery(title: string, channelTitle: string) {
  const parsed = parseVideoTitle(title, channelTitle);
  return `${normalizeMusicText(parsed.artist)} ${normalizeMusicText(parsed.title)}`
    .trim()
    .slice(0, 80);
}

function coverage(needle: string[], haystack: Set<string>) {
  if (needle.length === 0) return 0;
  return needle.filter((word) => haystack.has(word)).length / needle.length;
}

export type MatchCandidate = { title: string; artistName: string | null };

/**
 * Punteggio 0–1: tutte le parole del titolo devono esserci, e l'artista deve coincidere
 * almeno in parte. Sotto MATCH_THRESHOLD il candidato è scartato.
 */
export function matchScore(
  video: { title: string; channelTitle: string },
  candidate: MatchCandidate,
) {
  const parsed = parseVideoTitle(video.title, video.channelTitle);
  const wantedTitle = tokens(parsed.title);
  const wantedArtist = tokens(parsed.artist);
  const candidateTitle = new Set(tokens(candidate.title));
  const candidateAll = new Set([...candidateTitle, ...tokens(candidate.artistName ?? '')]);
  const titleScore = coverage(wantedTitle, candidateTitle);
  const artistScore = coverage(wantedArtist, candidateAll);
  if (titleScore < 1 || artistScore < 0.5) return 0;
  // Penalize candidates with many extra words in the title (other versions, mashups…).
  const extra = Math.max(0, candidateTitle.size - wantedTitle.length);
  return Math.max(0, 0.6 + 0.4 * artistScore - extra * 0.05);
}

export const MATCH_THRESHOLD = 0.75;

export function bestMatch<T extends MatchCandidate>(
  video: { title: string; channelTitle: string },
  candidates: T[],
) {
  let best: { item: T; score: number } | null = null;
  for (const item of candidates) {
    const score = matchScore(video, item);
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { item, score };
  }
  return best?.item ?? null;
}

const UNWANTED_VERSION =
  /\b(cover|karaoke|reaction|tutorial|lesson|instrumental|nightcore|slowed|sped up|8d|remix|live|acoustic|piano version|guitar)\b/i;

export type SongToFind = { title: string; artist: string | null };
export type VideoCandidate = { videoId: string; title: string; channelTitle: string };

/**
 * The YouTube video of an imported song (artist + title), or null when no result is a safe
 * match. Prefers the original version (no covers, karaoke, live or remix unless asked for)
 * and official channels (artist name, "- Topic", VEVO).
 */
export function pickVideoForSong<T extends VideoCandidate>(song: SongToFind, videos: T[]) {
  // "Title - Remastered 2011" / "Title - Live": the part before the dash is the song.
  const baseTitle = song.title.split(/\s[-–—]\s/)[0] ?? song.title;
  const cleanTitle = tokens(baseTitle);
  const wantedTitle = cleanTitle.length > 0 ? cleanTitle : plainTokens(baseTitle);
  const titleWordsOf = cleanTitle.length > 0 ? tokens : plainTokens;
  const mainArtist = (song.artist ?? '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0] ?? '';
  const wantedArtist = tokens(mainArtist);
  if (wantedTitle.length === 0) return null;
  const askedVersion = UNWANTED_VERSION.test(song.title);
  let best: { item: T; score: number } | null = null;
  videos.forEach((video, index) => {
    const titleWords = new Set(titleWordsOf(video.title));
    const channelWords = tokens(video.channelTitle);
    const allWords = new Set([...titleWords, ...channelWords]);
    const titleScore = coverage(wantedTitle, titleWords);
    const artistScore = wantedArtist.length ? coverage(wantedArtist, allWords) : 1;
    if (titleScore < 0.8 || artistScore < 0.5) return;
    const isVersion = UNWANTED_VERSION.test(video.title);
    // Not asked for: penalise covers/live/remix. Asked for (e.g. "(Live 1999)"): prefer them.
    const unwanted = askedVersion ? !isVersion : isVersion;
    const channel = video.channelTitle.toLowerCase();
    const official =
      /- topic$|vevo$/i.test(video.channelTitle) ||
      (wantedArtist.length > 0 && wantedArtist.every((word) => channel.includes(word)));
    const score =
      0.6 * titleScore +
      0.4 * artistScore -
      (unwanted ? 0.4 : 0) +
      (official ? 0.05 : 0) -
      index * 0.005;
    if (score >= 0.7 && (!best || score > best.score)) best = { item: video, score };
  });
  return (best as { item: T; score: number } | null)?.item ?? null;
}

/**
 * Canonical form of a song for the shared resolution cache: exactly the words that decide the
 * YouTube query and the match. Two inputs with the same canonical form always get the same
 * search and the same choice, so the cache cannot be steered with punctuation or operators.
 */
export function songCanonical(song: SongToFind) {
  const baseTitle = song.title.split(/\s[-–—]\s/)[0] ?? song.title;
  const mainArtist = (song.artist ?? '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0] ?? '';
  const cleanTitle = tokens(baseTitle);
  const titleWords = cleanTitle.length > 0 ? cleanTitle : plainTokens(baseTitle);
  const artistWords = tokens(mainArtist);
  const version = UNWANTED_VERSION.exec(song.title)?.[0]?.toLowerCase() ?? null;
  return {
    titleWords,
    artistWords,
    version,
    /** Letters and digits only: no quotes, dashes or YouTube search operators reach the query. */
    query: [
      ...artistWords,
      ...titleWords,
      ...(version && !titleWords.includes(version) ? [version] : []),
    ]
      .join(' ')
      .slice(0, 80),
    key: JSON.stringify([artistWords, titleWords, version]),
  };
}
