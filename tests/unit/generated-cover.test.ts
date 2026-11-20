// @polsia:user-owned — copertina generata deterministica: iniziali (1–2 grafemi) e gradiente CSS
// stabile dal testo. Nessuna rete, pura.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { coverGradient, coverInitials } from '@/lib/music/generated-cover';

describe('coverInitials', () => {
  it('una parola → una iniziale; due o più → prima+ultima; maiuscole', () => {
    expect(coverInitials('Alba')).toBe('A');
    expect(coverInitials('Zitti e Buoni')).toBe('ZB');
    expect(coverInitials('il cielo in una stanza')).toBe('IS');
    expect(coverInitials('élan')).toBe('É');
  });

  it('testo vuoto o solo spazi → segnaposto ♪', () => {
    expect(coverInitials('')).toBe('♪');
    expect(coverInitials('   ')).toBe('♪');
    expect(coverInitials(null)).toBe('♪');
    expect(coverInitials(undefined)).toBe('♪');
  });
});

describe('coverGradient', () => {
  it('deterministico: stesso seme → stesso gradiente', () => {
    expect(coverGradient('Alba')).toBe(coverGradient('Alba'));
  });

  it('semi diversi → gradienti diversi', () => {
    expect(coverGradient('Alba')).not.toBe(coverGradient('Tramonto'));
  });

  it('formato: linear-gradient con due hsl e S/L fissi', () => {
    expect(coverGradient('Qualcosa')).toMatch(
      /^linear-gradient\(135deg, hsl\(\d{1,3} 58% 45%\), hsl\(\d{1,3} 64% 34%\)\)$/,
    );
  });

  it('seme vuoto/assente è stabile (stesso del segnaposto)', () => {
    const base = coverGradient('');
    expect(coverGradient(null)).toBe(base);
    expect(coverGradient('   ')).toBe(base);
  });
});
