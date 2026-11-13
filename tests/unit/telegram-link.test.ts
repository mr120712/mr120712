// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: { BETTER_AUTH_SECRET: 'test-secret-123' } }));

import { createTelegramLinkToken, verifyTelegramLinkToken } from '@/lib/business/telegram-link';

describe('telegram link token', () => {
  it('round-trip: verifica restituisce lo stesso userId', () => {
    const token = createTelegramLinkToken('user-42');
    expect(verifyTelegramLinkToken(token)).toBe('user-42');
  });

  it('rifiuta un token scaduto', () => {
    const token = createTelegramLinkToken('user-1', 1000);
    // 16 minuti dopo (TTL = 15 min)
    expect(verifyTelegramLinkToken(token, 1000 + 16 * 60 * 1000)).toBeNull();
  });

  it('rifiuta una firma manomessa', () => {
    const token = createTelegramLinkToken('user-1');
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(verifyTelegramLinkToken(tampered)).toBeNull();
  });

  it('rifiuta un payload manomesso (userId diverso)', () => {
    const token = createTelegramLinkToken('user-1');
    const [, sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ u: 'admin', e: Date.now() + 60_000 }),
    ).toString('base64url');
    expect(verifyTelegramLinkToken(`${forgedPayload}.${sig}`)).toBeNull();
  });

  it('rifiuta un formato non valido', () => {
    expect(verifyTelegramLinkToken('senza-punto')).toBeNull();
    expect(verifyTelegramLinkToken('')).toBeNull();
    expect(verifyTelegramLinkToken('.abc')).toBeNull();
  });
});
