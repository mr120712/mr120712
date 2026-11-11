// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applySolcoProTheme } from '@/lib/business/solco-pro-theme';

describe('temi extra Solco Pro', () => {
  it('applica e rimuove la scelta dal tema globale dell’interfaccia', () => {
    applySolcoProTheme('amber');
    expect(document.documentElement.dataset.solcoProTheme).toBe('amber');
    applySolcoProTheme('default');
    expect(document.documentElement.dataset.solcoProTheme).toBeUndefined();
  });
});
