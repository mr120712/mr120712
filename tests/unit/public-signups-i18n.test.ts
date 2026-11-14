// @polsia:user-owned — testi del contatore iscritti della landing: presenti e tradotti in ogni
// lingua, numeri con i separatori della lingua, singolare/plurale corretti, "+N" solo se N > 0.
import { describe, expect, it } from 'vitest';
import {
  formatLandingNumber,
  LANDING_LOCALES,
  LANDING_MESSAGES,
  type LandingLocale,
  landingSignupsText,
  pickLandingPlural,
} from '@/lib/i18n/landing';

const CODES = LANDING_LOCALES.map((locale) => locale.code);

describe('contatore iscritti: traduzioni', () => {
  it('ogni lingua ha etichetta e "nuovi" al singolare e al plurale, non vuoti', () => {
    expect(CODES).toEqual(['it', 'en', 'es', 'fr', 'de', 'pt']);
    for (const code of CODES) {
      const { signups } = LANDING_MESSAGES[code];
      expect(Object.keys(signups).sort(), code).toEqual(['label', 'recent']);
      for (const forms of [signups.label, signups.recent]) {
        expect(Object.keys(forms).sort(), code).toEqual(['one', 'other']);
        expect(forms.one.trim(), code).not.toBe('');
        expect(forms.other.trim(), code).not.toBe('');
      }
      // Il numero dei nuovi entra dal segnaposto; l'etichetta segue il numero grande e non ne ha.
      expect(signups.recent.one, code).toContain('{n}');
      expect(signups.recent.other, code).toContain('{n}');
      expect(signups.label.one, code).not.toContain('{n}');
      expect(signups.label.other, code).not.toContain('{n}');
      expect(signups.label.one, code).toContain('Solco');
      expect(signups.label.other, code).toContain('Solco');
      expect(signups.label.one, code).not.toBe(signups.label.other);
    }
  });

  it('le lingue non italiane sono davvero tradotte', () => {
    for (const code of CODES.filter((code) => code !== 'it')) {
      const { signups } = LANDING_MESSAGES[code];
      expect(signups.label.other, code).not.toBe(LANDING_MESSAGES.it.signups.label.other);
      expect(signups.recent.other, code).not.toBe(LANDING_MESSAGES.it.signups.recent.other);
    }
  });
});

describe('contatore iscritti: numeri nel formato della lingua', () => {
  it('separatori delle migliaia di ogni lingua (tedesco col punto, francese con lo spazio)', () => {
    expect(formatLandingNumber(12345, 'it')).toBe('12.345');
    expect(formatLandingNumber(12345, 'en')).toBe('12,345');
    expect(formatLandingNumber(12345, 'es')).toBe('12.345');
    expect(formatLandingNumber(12345, 'de')).toBe('12.345');
    expect(formatLandingNumber(1234567, 'de')).toBe('1.234.567');
    expect(formatLandingNumber(12345, 'fr')).toMatch(/^12[  ]345$/);
    expect(formatLandingNumber(1234567, 'fr')).toMatch(/^1[  ]234[  ]567$/);
    expect(formatLandingNumber(12345, 'pt')).toBe('12.345');
    expect(formatLandingNumber(7, 'de')).toBe('7');
  });

  it('singolare per 1, plurale per gli altri numeri (anche 1.000.000 in francese/italiano)', () => {
    const forms = { one: 'uno', other: 'altri' };
    for (const code of CODES) {
      expect(pickLandingPlural(forms, 1, code), code).toBe('uno');
      expect(pickLandingPlural(forms, 2, code), code).toBe('altri');
      expect(pickLandingPlural(forms, 1_000_000, code), code).toBe('altri');
    }
  });
});

describe('landingSignupsText', () => {
  const expected: Record<LandingLocale, { phrase: string }> = {
    it: { phrase: '12.345 iscritti a Solco, +87 nuovi negli ultimi 7 giorni' },
    en: { phrase: '12,345 people on Solco, +87 new in the last 7 days' },
    es: { phrase: '12.345 personas en Solco, +87 en los últimos 7 días' },
    fr: { phrase: '12 345 inscrits sur Solco, +87 nouveaux ces 7 derniers jours' },
    de: { phrase: '12.345 Mitglieder bei Solco, +87 neue in den letzten 7 Tagen' },
    pt: { phrase: '12.345 pessoas no Solco, +87 nos últimos 7 dias' },
  };

  it('frase unica (numero + etichetta + nuovi) in ogni lingua', () => {
    for (const code of CODES) {
      const text = landingSignupsText({ total: 12345, last7Days: 87 }, code);
      // L'ICU di alcune versioni usa lo spazio non separabile normale per il francese.
      expect(text.phrase.replace(' ', ' '), code).toBe(expected[code].phrase);
      expect(text.phrase.startsWith(`${text.count} ${text.label}`), code).toBe(true);
      expect(text.recent, code).not.toBeNull();
    }
  });

  it('"+N" solo se ci sono nuovi negli ultimi 7 giorni', () => {
    const text = landingSignupsText({ total: 40, last7Days: 0 }, 'it');
    expect(text.recent).toBeNull();
    expect(text.phrase).toBe('40 iscritti a Solco');
  });

  it('singolare corretto per 1 iscritto e per 1 nuovo', () => {
    expect(landingSignupsText({ total: 1, last7Days: 1 }, 'it').phrase).toBe(
      '1 iscritto a Solco, +1 nuovo negli ultimi 7 giorni',
    );
    expect(landingSignupsText({ total: 1, last7Days: 1 }, 'en').phrase).toBe(
      '1 person on Solco, +1 new in the last 7 days',
    );
    expect(landingSignupsText({ total: 1, last7Days: 1 }, 'fr').phrase).toBe(
      '1 inscrit sur Solco, +1 nouveau ces 7 derniers jours',
    );
    expect(landingSignupsText({ total: 1, last7Days: 1 }, 'de').phrase).toBe(
      '1 Mitglied bei Solco, +1 neues in den letzten 7 Tagen',
    );
    expect(landingSignupsText({ total: 1, last7Days: 1 }, 'es').label).toBe('persona en Solco');
    expect(landingSignupsText({ total: 1, last7Days: 1 }, 'pt').label).toBe('pessoa no Solco');
    expect(landingSignupsText({ total: 2, last7Days: 2 }, 'it').phrase).toBe(
      '2 iscritti a Solco, +2 nuovi negli ultimi 7 giorni',
    );
  });

  it('il numero dei nuovi è formattato nella lingua', () => {
    expect(landingSignupsText({ total: 50000, last7Days: 1234 }, 'de').recent).toBe(
      '+1.234 neue in den letzten 7 Tagen',
    );
    expect(landingSignupsText({ total: 50000, last7Days: 1234 }, 'en').recent).toBe(
      '+1,234 new in the last 7 days',
    );
  });
});
