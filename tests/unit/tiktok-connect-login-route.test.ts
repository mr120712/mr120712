// @polsia:user-owned — GET /api/admin/tiktok/connect/login: parte solo da Solco stesso. Da un altro
// sito (o da un sottodominio) torna alla pagina admin senza cookie; dalla web app iOS, che WebKit
// può marcare cross-site, parte se il Referer è di Solco.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  session: {
    user: { id: 'admin-1', role: 'admin', email: 'bestmr12@icloud.com', emailVerified: true },
  } as {
    user: { id: string; role: string; email?: string; emailVerified: boolean };
  } | null,
}));

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: async () => mocks.session } },
}));
vi.mock('@/lib/tiktok/config.server', () => ({
  TIKTOK_ADMIN_PAGE: '/admin/tiktok',
  TIKTOK_AUTHORIZE_URL: 'https://www.tiktok.com/v2/auth/authorize/',
  TIKTOK_SCOPES: ['user.info.basic', 'video.publish'],
  notConfiguredResponse: () => new Response(null, { status: 404 }),
  tiktokConfig: () => ({
    clientKey: 'k',
    redirectUri: 'https://solco.test/api/admin/tiktok/connect/callback',
    appOrigin: 'https://solco.test',
  }),
  tiktokPrivateHeaders: { 'Cache-Control': 'private, no-store' },
}));
vi.mock('@/lib/tiktok/connection.server', () => ({
  sealOAuthCookie: async () => 'sealed',
  oauthCookieHeader: () => 'solco_tiktok_oauth=sealed; Path=/api/admin/tiktok; HttpOnly',
}));

import { GET } from '@/app/api/admin/tiktok/connect/login/route';

const ADMIN_PAGE = 'https://solco.test/admin/tiktok';

function req(headers: Record<string, string>) {
  return new Request('https://solco.test/api/admin/tiktok/connect/login', { headers });
}

beforeEach(() => {
  mocks.session = {
    user: { id: 'admin-1', role: 'admin', email: 'bestmr12@icloud.com', emailVerified: true },
  };
});

describe('GET /api/admin/tiktok/connect/login', () => {
  it('da Solco stesso (same-origin, nessuna intestazione, indirizzo digitato) va a TikTok col cookie', async () => {
    const fromSolco: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-origin' },
      {},
      { 'sec-fetch-site': 'none' },
    ];
    for (const headers of fromSolco) {
      const response = await GET(req(headers));
      expect(response.status, JSON.stringify(headers)).toBe(302);
      const location = new URL(response.headers.get('location') ?? '');
      expect(location.origin).toBe('https://www.tiktok.com');
      expect(location.searchParams.get('client_key')).toBe('k');
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(response.headers.get('set-cookie')).toContain('solco_tiktok_oauth=');
    }
  });

  it('da un altro sito o da un sottodominio torna alla pagina admin senza cookie', async () => {
    const foreign: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'cross-site', referer: 'https://altro.example/' },
      { 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of foreign) {
      const response = await GET(req(headers));
      expect(response.headers.get('location'), JSON.stringify(headers)).toBe(ADMIN_PAGE);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('dalla web app iOS (cross-site ma Referer di Solco) parte come da Solco', async () => {
    const response = await GET(
      req({ 'sec-fetch-site': 'cross-site', referer: 'https://solco.test/admin/tiktok' }),
    );
    expect(new URL(response.headers.get('location') ?? '').origin).toBe('https://www.tiktok.com');
    expect(response.headers.get('set-cookie')).toContain('solco_tiktok_oauth=');
  });

  it('senza admin verificato non parte', async () => {
    mocks.session = { user: { id: 'u1', role: 'user', emailVerified: true } };
    expect((await GET(req({ 'sec-fetch-site': 'same-origin' }))).headers.get('location')).toBe(
      ADMIN_PAGE,
    );
    mocks.session = null;
    expect((await GET(req({ 'sec-fetch-site': 'same-origin' }))).headers.get('location')).toBe(
      'https://solco.test/login?callbackURL=%2Fadmin%2Ftiktok',
    );
  });
});
