// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  decryptStoredAudioSegment,
  encryptStoredAudioSegment,
} from '@/lib/music/audio-encryption.server';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('cifratura dei segmenti audio custoditi da Solco', () => {
  it('decifra un segmento AES-256-GCM dopo aver sbloccato la chiave con RSA-OAEP-SHA-256', () => {
    const original = Buffer.from('audio integrale di prova');
    const segment = encryptStoredAudioSegment(original, publicKey, 'track:42:segment:0');

    expect(segment.format).toBe('solco-aes-256-gcm-rsa-oaep-sha256-v1');
    expect(decryptStoredAudioSegment(segment, privateKey, 'track:42:segment:0')).toEqual(original);
  });

  it('rifiuta dati alterati e un contesto di traccia differente', () => {
    const segment = encryptStoredAudioSegment(
      Buffer.from('audio protetto'),
      publicKey,
      'track:42:segment:0',
    );
    const ciphertext = Buffer.from(segment.ciphertext, 'base64');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;

    expect(() => decryptStoredAudioSegment(
      { ...segment, ciphertext: ciphertext.toString('base64') },
      privateKey,
      'track:42:segment:0',
    )).toThrow();
    expect(() => decryptStoredAudioSegment(segment, privateKey, 'track:99:segment:0')).toThrow();
  });

  it('non restituisce né registra chiavi RSA o AES nel record cifrato', () => {
    const segment = encryptStoredAudioSegment(
      Buffer.from('audio non in chiaro'),
      publicKey,
      'track:42:segment:0',
    );
    const serialized = JSON.stringify(segment);

    expect(serialized).not.toContain(privateKey);
    expect(Object.keys(segment)).not.toContain('key');
    expect(Object.keys(segment)).not.toContain('privateKey');
    expect(Object.keys(segment)).not.toContain('aesKey');
    expect(serialized).not.toContain('audio non in chiaro');
  });
});
