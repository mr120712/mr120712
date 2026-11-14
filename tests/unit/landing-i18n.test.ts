// @polsia:user-owned — traduzioni della landing: complete in ogni lingua, scelta della lingua.
import { describe, expect, it } from 'vitest';
import {
  formatLandingPrice,
  LANDING_LOCALES,
  LANDING_MESSAGES,
  type LandingMessages,
  resolveLandingLocale,
} from '@/lib/i18n/landing';

function shape(messages: LandingMessages) {
  return {
    keys: Object.keys(messages).sort(),
    marquee: messages.marquee.length,
    plans: Object.fromEntries(
      Object.entries(messages.plans).map(([id, plan]) => [id, plan.perks.length]),
    ),
  };
}

describe('landing in più lingue', () => {
  it('ogni lingua ha tutti i testi (stessa forma dell’italiano), nessuno vuoto', () => {
    const reference = shape(LANDING_MESSAGES.it);
    for (const { code } of LANDING_LOCALES) {
      const messages = LANDING_MESSAGES[code];
      expect(shape(messages), code).toEqual(reference);
      const texts = [
        messages.languageLabel,
        messages.login,
        messages.kicker,
        messages.titleLine1,
        messages.titleLine2,
        messages.lead,
        messages.ctaStart,
        messages.ctaLogin,
        messages.plansTitle,
        messages.plansLead,
        messages.perYear('X'),
        ...messages.marquee,
        ...Object.values(messages.legal),
        ...Object.values(messages.plans).flatMap((plan) => [plan.tagline, ...plan.perks]),
      ];
      for (const text of texts) expect(text.trim(), code).not.toBe('');
      expect(messages.perYear('X'), code).toContain('X');
    }
  });

  it('avviso "app in italiano" in ogni lingua tranne l’italiano', () => {
    expect(LANDING_MESSAGES.it.appLanguageNote).toBe('');
    for (const { code } of LANDING_LOCALES.filter((locale) => locale.code !== 'it')) {
      expect(LANDING_MESSAGES[code].appLanguageNote.trim(), code).not.toBe('');
    }
  });

  it('le lingue non italiane sono davvero tradotte', () => {
    for (const { code } of LANDING_LOCALES.filter((locale) => locale.code !== 'it')) {
      expect(LANDING_MESSAGES[code].titleLine1, code).not.toBe(LANDING_MESSAGES.it.titleLine1);
      expect(LANDING_MESSAGES[code].plansTitle, code).not.toBe(LANDING_MESSAGES.it.plansTitle);
    }
  });

  it('priorità: ?lang=, scelta salvata, browser, italiano', () => {
    expect(resolveLandingLocale({ param: 'EN', stored: 'de', browser: ['fr'] })).toBe('en');
    expect(resolveLandingLocale({ param: 'xx', stored: 'de', browser: ['fr'] })).toBe('de');
    expect(resolveLandingLocale({ stored: 'zz', browser: ['ja-JP', 'pt-BR'] })).toBe('pt');
    expect(resolveLandingLocale({ browser: ['ja-JP'] })).toBe('it');
    expect(resolveLandingLocale({})).toBe('it');
  });

  it('prezzi in euro nel formato di ogni lingua; 0 è "gratis" tradotto', () => {
    expect(formatLandingPrice(499, 'it')).toMatch(/^4,99\s€$/);
    expect(formatLandingPrice(499, 'en')).toBe('€4.99');
    expect(formatLandingPrice(0, 'en')).toBe('Free');
    expect(formatLandingPrice(0, 'de')).toBe('Kostenlos');
    expect(formatLandingPrice(12999, 'de')).toMatch(/^129,99\s€$/);
  });
});
