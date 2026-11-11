// @polsia:user-owned
// @vitest-environment node
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAppleClientSecret,
  resolveAppleClientSecret,
} from '@/lib/business/apple-client-secret';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('Sign in with Apple', () => {
  it('firma un client secret ES256 valido per Apple, con scadenza entro 6 mesi', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    const jwt = buildAppleClientSecret({
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      clientId: 'app.solco.web',
      privateKey: pem,
      now,
    });
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
    expect(claims).toMatchObject({
      iss: 'TEAM123456',
      sub: 'app.solco.web',
      aud: 'https://appleid.apple.com',
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(180 * 24 * 3600);
    const valid = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature ?? '', 'base64url'),
    );
    expect(valid).toBe(true);
  });

  it('accetta la chiave con "\\n" scritti nella variabile e resta spento se mancano dati', () => {
    const escaped = pem.replace(/\n/g, '\\n');
    expect(
      resolveAppleClientSecret({
        APPLE_CLIENT_ID: 'app.solco.web',
        APPLE_TEAM_ID: 'T',
        APPLE_KEY_ID: 'K',
        APPLE_PRIVATE_KEY: escaped,
      }),
    ).toMatch(/^ey/);
    expect(resolveAppleClientSecret({ APPLE_CLIENT_ID: 'app.solco.web' })).toBeUndefined();
    expect(
      resolveAppleClientSecret({
        APPLE_CLIENT_ID: 'x',
        APPLE_TEAM_ID: 'T',
        APPLE_KEY_ID: 'K',
        APPLE_PRIVATE_KEY: 'broken',
      }),
    ).toBeUndefined();
    expect(resolveAppleClientSecret({ APPLE_CLIENT_ID: 'x', APPLE_CLIENT_SECRET: 'premade' })).toBe(
      'premade',
    );
  });
});
