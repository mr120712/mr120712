// @polsia:user-owned
// @vitest-environment node
//
// Test AVVERSARIALE del verificatore JWS: usa una catena "vera" (fidata) e una catena
// "dell'aggressore" (root diversa) per dimostrare che l'UNICA barriera di fiducia è
// l'ancoraggio alla root pinnata, e che un aggressore NON può farsi accettare un payload
// forgiato appiccicando la root vera in fondo alla propria catena.
import { createPrivateKey, sign, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { verifyAppleSignedPayload } from '@/lib/business/iap/apple-jws.server';

const fx = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'apple-jws-chain.json'), 'utf8'),
) as {
  x5c: string[];
  rootPem: string;
  leafKeyPem: string;
  atkX5c: string[];
  atkRootPem: string;
  atkLeafKeyPem: string;
};

// Dentro la validità delle fixture (certificati generati a novembre 2026).
const now = new Date('2026-12-15T00:00:00.000Z');

/** DER base64 (x5c) di un certificato PEM. */
function derB64(pem: string): string {
  return new X509Certificate(pem).raw.toString('base64');
}

function jws(leafKeyPem: string, x5c: string[], payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', x5c })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), {
    key: createPrivateKey(leafKeyPem),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${h}.${p}.${sig}`;
}

describe('verifyAppleSignedPayload — catena avversariale', () => {
  it('T1: catena vera + root vera pinnata → accettata', () => {
    const token = jws(fx.leafKeyPem, fx.x5c, { productId: 'ok' });
    expect(verifyAppleSignedPayload(token, fx.rootPem, now).productId).toBe('ok');
  });

  it('T2: catena vera ma si pinna una root diversa → rifiutata', () => {
    const token = jws(fx.leafKeyPem, fx.x5c, { productId: 'ok' });
    expect(() => verifyAppleSignedPayload(token, fx.atkRootPem, now)).toThrow();
  });

  it('T3: l’aggressore appiccica la root VERA alla PROPRIA catena → DEVE rifiutare', () => {
    // [atk_leaf, atk_int, real_root]: la root pinnata combacia, ma atk_int NON è firmato da real_root.
    const forged = [fx.atkX5c[0], fx.atkX5c[1], derB64(fx.rootPem)] as string[];
    const token = jws(fx.atkLeafKeyPem, forged, { productId: 'HACKED' });
    expect(() => verifyAppleSignedPayload(token, fx.rootPem, now)).toThrow();
  });

  it('T4 (controllo): catena dell’aggressore + si pinna la sua root → accettata (la sicurezza è TUTTA nel pinning)', () => {
    const token = jws(fx.atkLeafKeyPem, fx.atkX5c, { productId: 'atk' });
    expect(verifyAppleSignedPayload(token, fx.atkRootPem, now).productId).toBe('atk');
  });

  it('T5: certificati dell’aggressore ma firma con la chiave della foglia vera → rifiutata', () => {
    const forged = [fx.atkX5c[0], fx.atkX5c[1], derB64(fx.rootPem)] as string[];
    const token = jws(fx.leafKeyPem, forged, { productId: 'HACKED2' });
    expect(() => verifyAppleSignedPayload(token, fx.rootPem, now)).toThrow();
  });
});
