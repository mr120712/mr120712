// @polsia:user-owned
// @vitest-environment node
// Test del flusso "Connetti YouTube" (OAuth Google): cifratura token, cookie OAuth, confronto dello
// state, scope, configurazione e keying del re-sync. Niente rete né DB reale.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { youtubeAccountConfig } from '@/lib/youtube-account/config.server';
import {
  hasRequiredScopes,
  openOAuthCookie,
  sealOAuthCookie,
  statesMatch,
} from '@/lib/youtube-account/connection.server';
import { dbToYouTubePlaylistId, youtubeSourceDb } from '@/lib/youtube-account/import.server';
import { hasTokenKey, openValue, sealValue } from '@/lib/youtube-account/token-crypto.server';

beforeEach(() => {
  vi.stubEnv('GOOGLE_CLIENT_ID', '1234567890-abcdefg.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'GOCSPX-test-client-secret');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://solco.test');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-for-youtube-tokens');
  vi.stubEnv('YOUTUBE_TOKEN_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cifratura dei token YouTube', () => {
  it('cifra e decifra, e rifiuta valori manomessi o di un altro contesto', async () => {
    const sealed = await sealValue('ya29-access-token', 'youtube-access:u1');
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('ya29-access-token');
    expect(await openValue(sealed, 'youtube-access:u1')).toBe('ya29-access-token');
    // Stesso testo, IV diverso.
    expect(await sealValue('ya29-access-token', 'youtube-access:u1')).not.toBe(sealed);
    // Riga di un altro utente o altro scopo.
    expect(await openValue(sealed, 'youtube-access:u2')).toBeNull();
    const [version, iv, ciphertext] = sealed.split('.');
    const flipped = `${ciphertext?.[0] === 'A' ? 'B' : 'A'}${ciphertext?.slice(1)}`;
    expect(await openValue(`${version}.${iv}.${flipped}`, 'youtube-access:u1')).toBeNull();
    expect(await openValue('v2.abc.def', 'youtube-access:u1')).toBeNull();
    expect(await openValue('garbage', 'youtube-access:u1')).toBeNull();
    expect(await openValue(`${sealed}.extra`, 'youtube-access:u1')).toBeNull();
  });

  it('usa YOUTUBE_TOKEN_KEY se presente e la rifiuta se non è di 32 byte', async () => {
    const sealedWithSecret = await sealValue('token', 'ctx');
    vi.stubEnv('YOUTUBE_TOKEN_KEY', Buffer.alloc(32, 7).toString('base64'));
    expect(hasTokenKey()).toBe(true);
    // Chiave diversa: il valore cifrato con il segreto non si apre più.
    expect(await openValue(sealedWithSecret, 'ctx')).toBeNull();
    const sealedWithKey = await sealValue('token', 'ctx');
    expect(await openValue(sealedWithKey, 'ctx')).toBe('token');
    vi.stubEnv('YOUTUBE_TOKEN_KEY', Buffer.alloc(16, 7).toString('base64'));
    expect(hasTokenKey()).toBe(false);
    expect(youtubeAccountConfig()).toBeNull();
  });
});

describe('configurazione', () => {
  it('è spenta senza client id/secret validi o origine non HTTPS', () => {
    expect(youtubeAccountConfig()).not.toBeNull();
    vi.stubEnv('GOOGLE_CLIENT_ID', 'not-a-google-client');
    expect(youtubeAccountConfig()).toBeNull();
    vi.stubEnv('GOOGLE_CLIENT_ID', '1234567890-abcdefg.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'short');
    expect(youtubeAccountConfig()).toBeNull();
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'GOCSPX-test-client-secret');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://solco.test');
    expect(youtubeAccountConfig()).toBeNull();
  });

  it('costruisce il redirect URI sul callback', () => {
    const config = youtubeAccountConfig();
    expect(config?.redirectUri).toBe('https://solco.test/api/music/youtube/callback');
    expect(config?.secureCookies).toBe(true);
  });
});

describe('cookie OAuth e state', () => {
  it('apre un cookie valido e rifiuta uno scaduto', async () => {
    const cookie = {
      state: 'A'.repeat(43),
      verifier: 'a'.repeat(64),
      userId: 'u1',
      issuedAt: Date.now(),
    };
    const sealed = await sealOAuthCookie(cookie);
    const opened = await openOAuthCookie(sealed);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.cookie.userId).toBe('u1');
    // Più vecchio di 10 minuti → scaduto.
    const old = await sealOAuthCookie({ ...cookie, issuedAt: Date.now() - 11 * 60_000 });
    const openedOld = await openOAuthCookie(old);
    expect(openedOld.ok).toBe(false);
    if (!openedOld.ok) expect(openedOld.reason).toBe('expired');
  });

  it('confronta lo state in modo costante', () => {
    expect(statesMatch('A'.repeat(43), 'A'.repeat(43))).toBe(true);
    expect(statesMatch('B'.repeat(43), 'A'.repeat(43))).toBe(false);
    expect(statesMatch('A', 'A'.repeat(43))).toBe(false);
    expect(statesMatch(null, 'A'.repeat(43))).toBe(false);
  });
});

describe('scope', () => {
  it('richiede youtube.readonly; null (refresh) è accettato', () => {
    expect(hasRequiredScopes(null)).toBe(true);
    expect(hasRequiredScopes('https://www.googleapis.com/auth/youtube.readonly')).toBe(true);
    expect(hasRequiredScopes('openid https://www.googleapis.com/auth/youtube.readonly email')).toBe(
      true,
    );
    expect(hasRequiredScopes('openid email')).toBe(false);
  });
});

describe('keying del re-sync', () => {
  it('serializza e rilegge una sorgente playlist, rifiutando input non validi', () => {
    const id = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';
    expect(youtubeSourceDb(id)).toBe(`playlist:${id}`);
    expect(dbToYouTubePlaylistId(youtubeSourceDb(id))).toBe(id);
    expect(dbToYouTubePlaylistId('saved')).toBeNull();
    expect(dbToYouTubePlaylistId('playlist:bad id!')).toBeNull();
    expect(dbToYouTubePlaylistId('')).toBeNull();
  });
});
