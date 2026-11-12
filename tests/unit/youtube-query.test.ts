// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  formatItalianDate,
  formatItalianDateWithArticle,
  formatItalianTime,
  nextYouTubeQuotaReset,
  normalizeYouTubeQuery,
  youtubeQuotaDay,
  youtubeQuotaDayStart,
  youtubeResultsUrl,
} from '@/lib/music/youtube-query';

describe('forma canonica delle ricerche YouTube', () => {
  it('unisce accenti, maiuscole, apostrofi, punteggiatura e spazi', () => {
    const variants = ['Perché ti amo', 'perche ti amo', 'PERCHÈ  ti   amo!', ' perché, ti amo… '];
    expect(new Set(variants.map(normalizeYouTubeQuery))).toEqual(new Set(['perche ti amo']));
    expect(normalizeYouTubeQuery('L’amore')).toBe(normalizeYouTubeQuery("l'amore"));
    expect(normalizeYouTubeQuery('"Vasco" | -Rossi')).toBe('vasco rossi');
    expect(normalizeYouTubeQuery('AC/DC')).toBe('ac dc');
  });

  it('piega le forme di compatibilità e toglie emoji, ma tiene R&B e le altre scritture', () => {
    expect(normalizeYouTubeQuery('Ｆｕｌｌ ﬁne')).toBe('full fine');
    expect(normalizeYouTubeQuery('🔥 Mahmood 🔥')).toBe('mahmood');
    expect(normalizeYouTubeQuery('R&B italiano')).toBe('r&b italiano');
    expect(normalizeYouTubeQuery('米津玄師 Lemon')).toBe('米津玄師 lemon');
    expect(normalizeYouTubeQuery('हिन्दी गाना')).toBe('हिन्दी गाना');
    expect(normalizeYouTubeQuery('방탄소년단')).toBe('방탄소년단');
    expect(normalizeYouTubeQuery('🎵 !!')).toBe('');
    expect(normalizeYouTubeQuery('a '.repeat(300)).length).toBeLessThanOrEqual(200);
  });

  it('il collegamento alla ricerca su YouTube è un semplice link codificato', () => {
    expect(youtubeResultsUrl(' Lucio Dalla & Caruso ')).toBe(
      'https://www.youtube.com/results?search_query=Lucio+Dalla+%26+Caruso',
    );
  });
});

describe('giorno e azzeramento della quota YouTube', () => {
  it('il giorno cambia a mezzanotte del Pacifico', () => {
    expect(youtubeQuotaDay(new Date('2026-11-12T07:59:59Z'))).toBe('2026-11-11');
    expect(youtubeQuotaDay(new Date('2026-11-12T08:00:00Z'))).toBe('2026-11-12');
    expect(youtubeQuotaDayStart('2026-11-12').toISOString()).toBe('2026-11-12T08:00:00.000Z');
    expect(youtubeQuotaDayStart('2026-07-01').toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });

  it('calcola l’ora italiana di ripresa, anche nelle settimane del cambio d’ora', () => {
    const reset = (iso: string) => formatItalianTime(nextYouTubeQuotaReset(new Date(iso)));
    // Winter: midnight Pacific = 9:00 in Italy.
    expect(nextYouTubeQuotaReset(new Date('2026-11-12T10:00:00Z')).toISOString()).toBe(
      '2026-11-13T08:00:00.000Z',
    );
    expect(reset('2026-11-12T10:00:00Z')).toBe('9:00');
    // Summer: both on daylight time, still 9:00.
    expect(reset('2026-07-01T12:00:00Z')).toBe('9:00');
    // US already on daylight time, Italy not yet (March) or no longer (late October): 8:00.
    expect(reset('2026-03-10T12:00:00Z')).toBe('8:00');
    expect(reset('2026-10-28T12:00:00Z')).toBe('8:00');
    // The 25-hour Pacific day when the US clocks go back.
    expect(nextYouTubeQuotaReset(new Date('2026-11-01T12:00:00Z')).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });

  it('scrive la data di salvataggio in italiano', () => {
    expect(formatItalianDate('2026-11-10T08:00:00Z')).toBe('10 novembre');
    // Articles: elision before otto and undici, ordinal for the first of the month.
    expect(formatItalianDateWithArticle('2026-11-10T08:00:00Z')).toBe('il 10 novembre');
    expect(formatItalianDateWithArticle('2026-11-08T08:00:00Z')).toBe('l’8 novembre');
    expect(formatItalianDateWithArticle('2026-11-11T08:00:00Z')).toBe('l’11 novembre');
    expect(formatItalianDateWithArticle('2026-11-01T08:00:00Z')).toBe('il 1º novembre');
    expect(formatItalianDateWithArticle('2026-11-18T08:00:00Z')).toBe('il 18 novembre');
  });
});
