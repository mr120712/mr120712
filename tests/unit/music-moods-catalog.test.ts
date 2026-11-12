// @polsia:user-owned — integrità del catalogo dei mood della Home.
import { Brain, CloudRain, Dumbbell, Heart, Moon, PartyPopper, Waves, Zap } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { findGenre } from '@/lib/music/genre-catalog';
import {
  AUDIUS_GENRES,
  AUDIUS_MOODS,
  findMood,
  isMoodId,
  MOOD_ICON_NAMES,
  MOOD_IDS,
  type MoodIconName,
  moodCatalog,
} from '@/lib/music/moods';

// Every icon name of the catalogue must be a real lucide-react export (checked by tsc too).
const lucideIcons = {
  Waves,
  Zap,
  Dumbbell,
  Brain,
  PartyPopper,
  CloudRain,
  Heart,
  Moon,
} satisfies Record<MoodIconName, unknown>;

describe('catalogo dei mood', () => {
  it('ha gli 8 mood con id stabili ed etichette italiane, nell’ordine delle chip', () => {
    expect(moodCatalog.map((mood) => [mood.id, mood.label])).toEqual([
      ['relax', 'Relax'],
      ['energia', 'Energia'],
      ['allenamento', 'Allenamento'],
      ['concentrazione', 'Concentrazione'],
      ['festa', 'Festa'],
      ['malinconia', 'Malinconia'],
      ['romantico', 'Romantico'],
      ['notte', 'Notte'],
    ]);
    expect(moodCatalog.map((mood) => mood.id)).toEqual([...MOOD_IDS]);
    for (const mood of moodCatalog) expect(mood.id).toMatch(/^[a-z]+$/);
  });

  it('usa solo mood e generi Audius verificati, da 2 a 4 ciascuno, senza doppioni', () => {
    for (const mood of moodCatalog) {
      const { moods, genres } = mood.audius;
      expect(moods.length, mood.id).toBeGreaterThanOrEqual(2);
      expect(moods.length, mood.id).toBeLessThanOrEqual(4);
      expect(genres.length, mood.id).toBeGreaterThanOrEqual(2);
      expect(genres.length, mood.id).toBeLessThanOrEqual(4);
      expect(new Set(moods).size, mood.id).toBe(moods.length);
      expect(new Set(genres).size, mood.id).toBe(genres.length);
      for (const value of moods) expect(AUDIUS_MOODS, mood.id).toContain(value);
      for (const value of genres) expect(AUDIUS_GENRES, mood.id).toContain(value);
    }
  });

  it('ogni mood ha un’icona lucide reale e diversa, una descrizione di una riga e le ricerche', () => {
    expect(new Set(moodCatalog.map((mood) => mood.icon)).size).toBe(moodCatalog.length);
    for (const mood of moodCatalog) {
      expect(MOOD_ICON_NAMES).toContain(mood.icon);
      expect(lucideIcons[mood.icon], mood.icon).toBeTruthy();
      expect(mood.description.length, mood.id).toBeGreaterThan(10);
      expect(mood.description.length, mood.id).toBeLessThanOrEqual(90);
      expect(mood.description, mood.id).not.toMatch(/\n/);
      expect(mood.description.endsWith('.'), mood.id).toBe(true);
      expect(mood.radioTags.length, mood.id).toBeGreaterThan(0);
      for (const tag of mood.radioTags) expect(tag).toMatch(/^[a-z][a-z ]{1,39}$/);
      expect(mood.podcastTerm.trim().length, mood.id).toBeGreaterThan(2);
    }
  });

  it('collega solo playlist esistenti del catalogo generi (nessuna ricerca YouTube in più)', () => {
    for (const mood of moodCatalog) {
      expect(mood.genreSlugs.length, mood.id).toBeLessThanOrEqual(6);
      expect(new Set(mood.genreSlugs).size, mood.id).toBe(mood.genreSlugs.length);
      for (const slug of mood.genreSlugs)
        expect(findGenre(slug), `${mood.id}: ${slug}`).not.toBeNull();
    }
  });

  it('usa i generi Audius misurati dal vivo (più brani OML riproducibili, più artisti)', () => {
    const genres = (id: string) => findMood(id)?.audius.genres;
    expect(genres('allenamento')).toEqual(['Dubstep', 'Drum & Bass', 'Trap']);
    expect(genres('romantico')).toEqual(['R&B/Soul', 'Jazz', 'Acoustic']);
    expect(genres('malinconia')).toEqual(['Alternative', 'Acoustic', 'Ambient']);
    // Mostly "All rights reserved" in these moods: they took the places of playable tracks.
    expect(genres('allenamento')).not.toContain('Hip-Hop/Rap');
    expect(genres('romantico')).not.toContain('Pop');
    expect(genres('malinconia')).not.toContain('R&B/Soul');
    // Notte: calm and dark, not the club remixes of Cool/Deep House/Electronic, nor Relax's Peaceful.
    expect(findMood('notte')?.audius).toEqual({
      moods: ['Brooding', 'Melancholy'],
      genres: ['Ambient', 'Downtempo'],
    });
  });

  it('cerca podcast pertinenti (verificato sulla directory iTunes italiana)', () => {
    const terms = Object.fromEntries(moodCatalog.map((mood) => [mood.id, mood.podcastTerm]));
    // 'sonno' also matched science fiction and German titles; 'dj set' minor personal mixes.
    expect(terms).toMatchObject({
      notte: 'dormire',
      festa: 'musica dance',
      concentrazione: 'produttività',
    });
  });

  it('Notte, che promette calma fino al sonno, collega solo playlist calme', () => {
    const notte = findMood('notte');
    expect(notte?.description).toContain('fino al sonno');
    expect(notte?.genreSlugs).toEqual(['dark-ambient-notte', 'ambient', 'vaporwave']);
    for (const slug of ['notte-techno', 'synthwave', 'techno', 'dark-techno']) {
      expect(notte?.genreSlugs).not.toContain(slug);
    }
    expect(findMood('relax')?.description).toBe(
      'Suoni morbidi per rallentare e staccare la spina.',
    );
  });

  it('due mood condividono al massimo una playlist, e mai la stessa ricerca sotto un altro slug', () => {
    for (const [index, mood] of moodCatalog.entries()) {
      for (const other of moodCatalog.slice(index + 1)) {
        const shared = mood.genreSlugs.filter((slug) => other.genreSlugs.includes(slug));
        expect(shared.length, `${mood.id} / ${other.id}: ${shared.join(', ')}`).toBeLessThanOrEqual(
          1,
        );
      }
      const queries = mood.genreSlugs.map((slug) => findGenre(slug)?.query);
      expect(new Set(queries).size, mood.id).toBe(queries.length);
    }
    expect(findMood('energia')?.genreSlugs).toEqual(['hyperpop', 'uk-garage', 'breakbeat']);
  });

  it('riconosce solo gli id del catalogo', () => {
    expect(findMood('relax')?.label).toBe('Relax');
    expect(findMood('notte')?.icon).toBe('Moon');
    for (const value of [null, undefined, '', 'Relax', 'tutto', 'relax ', '__proto__']) {
      expect(findMood(value)).toBeNull();
      expect(isMoodId(value)).toBe(false);
    }
  });
});
