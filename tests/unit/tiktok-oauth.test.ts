// @polsia:user-owned
// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

// La cifratura del cookie OAuth usa una chiave derivata da BETTER_AUTH_SECRET.
vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET = 'test-secret-for-tiktok-oauth-cookie-0123456789';
});

import { createCodeVerifier, createOAuthState } from '@/lib/spotify/pkce';
import {
  hasRequiredScopes,
  openOAuthCookie,
  sealOAuthCookie,
  statesMatch,
} from '@/lib/tiktok/connection.server';
import { buildDirectPostBody, TIKTOK_TITLE_MAX } from '@/lib/tiktok/publish.server';

describe('buildDirectPostBody', () => {
  it('usa PULL_FROM_URL e accorcia il title al limite TikTok', () => {
    const body = buildDirectPostBody({
      title: 'x'.repeat(TIKTOK_TITLE_MAX + 100),
      privacyLevel: 'SELF_ONLY',
      videoUrl: 'https://cdn.solco.test/a.mp4',
    }) as {
      post_info: { title: string; privacy_level: string };
      source_info: { source: string; video_url: string };
    };
    expect(body.source_info.source).toBe('PULL_FROM_URL');
    expect(body.source_info.video_url).toBe('https://cdn.solco.test/a.mp4');
    expect(body.post_info.privacy_level).toBe('SELF_ONLY');
    expect(body.post_info.title.length).toBe(TIKTOK_TITLE_MAX);
  });
});

describe('hasRequiredScopes', () => {
  it('richiede sia user.info.basic sia video.publish (virgole o spazi)', () => {
    expect(hasRequiredScopes('user.info.basic,video.publish')).toBe(true);
    expect(hasRequiredScopes('user.info.basic video.publish')).toBe(true);
    expect(hasRequiredScopes('user.info.basic')).toBe(false);
    expect(hasRequiredScopes('')).toBe(false);
  });
});

describe('statesMatch', () => {
  it('confronta in modo sicuro lo state', () => {
    const state = createOAuthState();
    expect(statesMatch(state, state)).toBe(true);
    expect(statesMatch('altro', state)).toBe(false);
    expect(statesMatch(null, state)).toBe(false);
  });
});

describe('cookie OAuth cifrato', () => {
  let sealed = '';
  const cookie = { state: '', verifier: '', userId: 'admin-1', issuedAt: 0 };

  beforeAll(async () => {
    cookie.state = createOAuthState();
    cookie.verifier = createCodeVerifier();
    cookie.issuedAt = Date.now();
    sealed = await sealOAuthCookie(cookie);
  });

  it('si apre e restituisce gli stessi valori', async () => {
    const opened = await openOAuthCookie(sealed);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.cookie.state).toBe(cookie.state);
      expect(opened.cookie.verifier).toBe(cookie.verifier);
      expect(opened.cookie.userId).toBe('admin-1');
    }
  });

  it('rifiuta un cookie manomesso', async () => {
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('a') ? 'b' : 'a'}`;
    const opened = await openOAuthCookie(tampered);
    expect(opened.ok).toBe(false);
  });

  it('rifiuta un cookie scaduto', async () => {
    const old = await sealOAuthCookie({ ...cookie, issuedAt: Date.now() - 601_000 });
    const opened = await openOAuthCookie(old);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe('expired');
  });
});
