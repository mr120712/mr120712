// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  cardsToStudy,
  genreDeck,
  gradeCard,
  historyDeck,
  masteredCount,
} from '@/lib/business/flashcards';
import type { HistoryEntry } from '@/lib/contracts/library';

const entry = (overrides: Partial<HistoryEntry>): HistoryEntry => ({
  qualifiedId: 'jamendo:1',
  title: 'Strada Nuova',
  artistName: 'Band Finta',
  artworkUrl: null,
  sourceLabel: 'Jamendo',
  sourceUrl: null,
  albumId: null,
  durationSeconds: 180,
  playbackMode: 'jamendo',
  playCount: 1,
  lastPlayedAt: '2026-11-11T10:00:00.000Z',
  ...overrides,
});

describe('flashcard: mazzi', () => {
  it('il mazzo generi ha una carta per genere (non le playlist) con il link per ascoltarlo', () => {
    const deck = genreDeck();
    expect(deck.length).toBeGreaterThan(20);
    expect(deck.every((card) => card.link?.href.startsWith('/generi/'))).toBe(true);
    expect(deck.some((card) => card.id === 'genre:natale')).toBe(false);
    expect(new Set(deck.map((card) => card.id)).size).toBe(deck.length);
  });

  it('i tuoi ascolti: solo musica, artista da "Artista - Titolo" per YouTube, senza doppioni', () => {
    const deck = historyDeck([
      entry({}),
      entry({ qualifiedId: 'jamendo:2' }),
      entry({
        qualifiedId: 'youtube:abcdefghijk',
        title: 'Gruppo Inventato - Luce del Mattino (Official Video)',
        artistName: 'GruppoInventatoVEVO',
        playbackMode: 'youtube',
      }),
      entry({
        qualifiedId: 'youtube:bbbbbbbbbbb',
        title: 'Solo un titolo',
        playbackMode: 'youtube',
      }),
      entry({ qualifiedId: 'radio:x', title: 'Radio Prova', playbackMode: 'radio' }),
    ]);
    expect(deck.map((card) => [card.front, card.back])).toEqual([
      ['Chi interpreta “Strada Nuova”?', 'Band Finta'],
      ['Chi interpreta “Luce del Mattino”?', 'Gruppo Inventato'],
    ]);
  });
});

describe('flashcard: ripasso Leitner', () => {
  const cards = [
    { id: 'a', front: 'A', back: 'a', topic: 't' },
    { id: 'b', front: 'B', back: 'b', topic: 't' },
    { id: 'c', front: 'C', back: 'c', topic: 't' },
  ];
  const now = Date.parse('2026-11-11T10:00:00Z');

  it('"Lo sapevo" rimanda la carta più avanti, "Da ripassare" la riporta subito', () => {
    let progress = gradeCard({}, 'a', true, now);
    expect(progress.a).toEqual({ box: 2, due: now + 24 * 60 * 60 * 1000 });
    progress = gradeCard(progress, 'a', true, now);
    expect(progress.a?.box).toBe(3);
    expect(progress.a?.due).toBe(now + 3 * 24 * 60 * 60 * 1000);
    progress = gradeCard(progress, 'a', false, now);
    expect(progress.a).toEqual({ box: 1, due: now });
  });

  it('mostra prima le carte scadute, poi le nuove, e conta quelle imparate', () => {
    const progress = {
      a: { box: 5, due: now + 1000 },
      b: { box: 1, due: now - 1 },
    };
    expect(cardsToStudy(cards, progress, now).map((card) => card.id)).toEqual(['b', 'c']);
    expect(masteredCount(cards, progress)).toBe(1);
  });
});
