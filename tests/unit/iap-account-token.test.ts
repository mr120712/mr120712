// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { iapAccountToken, iapAccountTokenMatches } from '@/lib/business/iap/account-token';

describe('iapAccountToken', () => {
  it('è deterministico e un UUID ben formato', () => {
    const a = iapAccountToken('user-123');
    const b = iapAccountToken('user-123');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('dà token diversi a utenti diversi', () => {
    expect(iapAccountToken('user-123')).not.toBe(iapAccountToken('user-456'));
  });
});

describe('iapAccountTokenMatches', () => {
  it('accetta il token del proprio utente (anche con maiuscole/spazi)', () => {
    const token = iapAccountToken('user-123');
    expect(iapAccountTokenMatches(token, 'user-123')).toBe(true);
    expect(iapAccountTokenMatches(` ${token.toUpperCase()} `, 'user-123')).toBe(true);
  });

  it('rifiuta il token di un altro utente (anti-replay)', () => {
    const victimToken = iapAccountToken('victim');
    expect(iapAccountTokenMatches(victimToken, 'attacker')).toBe(false);
  });

  it('rifiuta token assenti o malformati', () => {
    expect(iapAccountTokenMatches(null, 'user-123')).toBe(false);
    expect(iapAccountTokenMatches(undefined, 'user-123')).toBe(false);
    expect(iapAccountTokenMatches('', 'user-123')).toBe(false);
    expect(iapAccountTokenMatches('non-un-uuid', 'user-123')).toBe(false);
  });
});
