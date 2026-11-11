// @polsia:user-owned — flashcard musicali: mazzi (generi, ascolti, teoria) e ripasso con il
// metodo Leitner (5 scatole). Funzioni pure: lo stato del ripasso vive nel browser.
import type { HistoryEntry } from '@/lib/contracts/library';
import { parseVideoTitle } from '@/lib/music/background-match';
import { genreCatalog, genreFamilies } from '@/lib/music/genre-catalog';

export type Flashcard = {
  id: string;
  front: string;
  back: string;
  topic: string;
  link?: { href: string; label: string };
};

/** Genre quiz: the description on the front, the genre (and where to listen) on the back. */
export function genreDeck(): Flashcard[] {
  const labels = new Map(genreFamilies.map((family) => [family.id, family.label]));
  return genreCatalog
    .filter((genre) => genre.family !== 'playlist')
    .map((genre) => ({
      id: `genre:${genre.slug}`,
      front: `Quale genere è questo? ${genre.description}`,
      back: `${genre.name} · ${labels.get(genre.family) ?? 'Genere'}`,
      topic: 'generi',
      link: { href: `/generi/${genre.slug}`, label: `Ascolta ${genre.name}` },
    }));
}

const MUSIC_MODES = new Set(['youtube', 'audius', 'jamendo', 'solco']);

/** "Who performs it?" cards from the listener's own history (titles and artists only). */
export function historyDeck(history: HistoryEntry[], limit = 40): Flashcard[] {
  const seen = new Set<string>();
  const cards: Flashcard[] = [];
  for (const entry of history) {
    if (!MUSIC_MODES.has(entry.playbackMode)) continue;
    let title = entry.title.trim();
    let artist = entry.artistName.trim();
    if (entry.playbackMode === 'youtube') {
      // YouTube gives the channel, not the artist: use "Artist - Title" when the title has it.
      if (!/\s[-–—|]\s/.test(title)) continue;
      const parsed = parseVideoTitle(title, artist);
      title = parsed.title.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').trim();
      artist = parsed.artist;
    }
    if (!title || !artist) continue;
    const key = `${artist}|${title}`.toLocaleLowerCase('it-IT');
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({
      id: `history:${entry.qualifiedId}`,
      front: `Chi interpreta “${title}”?`,
      back: artist,
      topic: 'i tuoi ascolti',
    });
    if (cards.length >= limit) break;
  }
  return cards;
}

/** Days to wait before showing a card again, per Leitner box (1 = every session). */
export const BOX_INTERVAL_DAYS = [0, 0, 1, 3, 7, 14] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CardProgress = { box: number; due: number };
export type DeckProgress = Record<string, CardProgress>;

/** "Lo sapevo" moves the card up a box (seen later); "Da ripassare" sends it back to box 1. */
export function gradeCard(
  progress: DeckProgress,
  id: string,
  knew: boolean,
  now: number,
): DeckProgress {
  const box = knew ? Math.min(5, (progress[id]?.box ?? 1) + 1) : 1;
  const days = BOX_INTERVAL_DAYS[box] ?? 0;
  return { ...progress, [id]: { box, due: now + days * DAY_MS } };
}

/** Cards due now first (lowest box first), then new cards; cards not yet due are left out. */
export function cardsToStudy(cards: Flashcard[], progress: DeckProgress, now: number) {
  const due = cards.filter((card) => progress[card.id] && (progress[card.id]?.due ?? 0) <= now);
  const fresh = cards.filter((card) => !progress[card.id]);
  due.sort((a, b) => (progress[a.id]?.box ?? 1) - (progress[b.id]?.box ?? 1));
  return [...due, ...fresh];
}

export function masteredCount(cards: Flashcard[], progress: DeckProgress) {
  return cards.filter((card) => (progress[card.id]?.box ?? 0) >= 4).length;
}
