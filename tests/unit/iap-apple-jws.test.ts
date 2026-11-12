// @polsia:user-owned
// @vitest-environment node
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { verifyAppleSignedPayload } from '@/lib/business/iap/apple-jws.server';

const fx = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'apple-jws-chain.json'), 'utf8'),
) as { x5c: string[]; rootPem: string; otherRootPem: string; leafKeyPem: string };

// Dentro la finestra di validità della fixture (certificati generati a novembre 2026).
const now = new Date('2026-12-15T00:00:00.000Z');

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function makeJws(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'ES256', kid: 'test', x5c: fx.x5c },
): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${h}.${p}`), {
    key: createPrivateKey(fx.leafKeyPem),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${h}.${p}.${signature}`;
}

describe('verifyAppleSignedPayload', () => {
  it('verifica un JWS autentico e restituisce il payload', () => {
    const jws = makeJws({ transactionId: 't1', productId: 'solco_premium_monthly' });
    const payload = verifyAppleSignedPayload(jws, fx.rootPem, now);
    expect(payload.productId).toBe('solco_premium_monthly');
    expect(payload.transactionId).toBe('t1');
  });

  it('rifiuta un payload manomesso (firma non valida)', () => {
    const jws = makeJws({ productId: 'solco_premium_monthly' });
    const parts = jws.split('.');
    const forged = Buffer.from(JSON.stringify({ productId: 'HACKED' })).toString('base64url');
    const tampered = `${parts[0]}.${forged}.${parts[2]}`;
    expect(() => verifyAppleSignedPayload(tampered, fx.rootPem, now)).toThrow(/firma/i);
  });

  it('rifiuta una catena che termina su una radice NON fidata', () => {
    const jws = makeJws({ productId: 'p' });
    expect(() => verifyAppleSignedPayload(jws, fx.otherRootPem, now)).toThrow(/fidata/i);
  });

  it('rifiuta un JWS malformato', () => {
    expect(() => verifyAppleSignedPayload('a.b', fx.rootPem, now)).toThrow(/JWS/);
  });

  it('rifiuta un header senza ES256/x5c', () => {
    const jws = makeJws({ productId: 'p' }, { alg: 'HS256', x5c: fx.x5c });
    expect(() => verifyAppleSignedPayload(jws, fx.rootPem, now)).toThrow(/inatteso/i);
    const noX5c = makeJws({ productId: 'p' }, { alg: 'ES256' });
    expect(() => verifyAppleSignedPayload(noX5c, fx.rootPem, now)).toThrow(/inatteso/i);
  });

  it('rifiuta se non è configurata alcuna radice', () => {
    const jws = makeJws({ productId: 'p' });
    expect(() => verifyAppleSignedPayload(jws, '', now)).toThrow(/Root CA/i);
  });

  it('rifiuta certificati scaduti (now fuori validità)', () => {
    const jws = makeJws({ productId: 'p' });
    const longAgo = new Date('2000-01-01T00:00:00.000Z');
    expect(() => verifyAppleSignedPayload(jws, fx.rootPem, longAgo)).toThrow(/scaduto|valid/i);
  });
});
