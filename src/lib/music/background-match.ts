// @polsia:user-owned — trova lo stesso brano di un video YouTube su Audius o Jamendo, dove
// l'ascolto in background è consentito. Solo corrispondenze sicure: meglio "non trovato" che
// un brano sbagliato.

const NOISE =
  /\b(official|ufficiale|video|videoclip|music|musica|audio|lyrics?|testo|visuali[sz]er|hd|4k|hq|remaster(ed)?|live|clip|prod\.?|ft\.?|feat\.?|featuring|vevo|topic|records?|tv|channel)\b/gi;

/** Minuscolo, senza accenti, senza parentesi e parole di contorno ("Official Video", "VEVO"…). */
export function normalizeMusicText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: string) {
  return normalizeMusicText(value)
    .split(' ')
    .filter((word) => word.length > 1);
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
