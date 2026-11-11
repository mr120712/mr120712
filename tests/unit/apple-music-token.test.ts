// @polsia:user-owned
// @vitest-environment node
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  appleMusicConfig,
  buildAppleMusicDeveloperToken,
} from '@/lib/business/apple-music-token.server';

describe('developer token Apple Music', () => {
  it('firma un JWT ES256 con team, chiave, scadenza e origini di Solco', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const now = new Date('2026-11-11T12:00:00Z');
    const token = buildAppleMusicDeveloperToken({
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      privateKey: pem,
      origins: ['https://solcomusic.vercel.app'],
      now,
    });
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
    });
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
    expect(claims.iss).toBe('TEAM123456');
    expect(claims.origin).toEqual(['https://solcomusic.vercel.app']);
    expect(claims.exp - claims.iat).toBe(30 * 24 * 60 * 60);
    const ok = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature ?? '', 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('resta spento senza chiave e riusa il Team ID di Sign in with Apple', () => {
    expect(appleMusicConfig({ APPLE_TEAM_ID: 'T' })).toBeNull();
    expect(
      appleMusicConfig({
        APPLE_TEAM_ID: 'T',
        APPLE_MUSIC_KEY_ID: 'K',
        APPLE_MUSIC_PRIVATE_KEY: 'P',
      }),
    ).toEqual({ teamId: 'T', keyId: 'K', privateKey: 'P' });
  });
});
