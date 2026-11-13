// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sameOrigin: true,
  config: {
    clientId: 'x',
    appOrigin: 'https://solco.test',
    redirectUri: 'https://solco.test/api/spotify/callback',
    secureCookies: true,
  } as unknown,
  user: { id: 'u1' } as { id: string } | null,
  authFails: false,
  limited: null as Response | null,
  auth: { accessToken: 'tok' } as unknown,
  sync: { updated: [], failed: [], nothingToSync: true } as Record<string, unknown>,
  deleteConnection: vi.fn(async () => {}),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => mocks.sameOrigin }));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => {
    if (mocks.authFails) throw new Response('no', { status: 401 });
    return mocks.user;
  },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: async () => mocks.limited,
}));
vi.mock('@/lib/spotify/config.server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, spotifyConfig: () => mocks.config };
});
vi.mock('@/lib/spotify/connection.server', () => ({
  spotifyAuthFor: async () => mocks.auth,
  deleteConnection: mocks.deleteConnection,
}));
vi.mock('@/lib/spotify/import.server', () => ({ runSpotifySync: async () => mocks.sync }));

import { POST } from '@/app/api/spotify/sync/route';

const req = () => new Request('https://solco.test/api/spotify/sync', { method: 'POST' });

const entry = {
  collectionId: 'c1',
  name: 'Brani salvati su Spotify',
  imported: 10,
  skipped: 0,
  truncated: 0,
  source: 'saved',
  added: 3,
  removed: 1,
};

beforeEach(() => {
  mocks.sameOrigin = true;
  mocks.config = {
    clientId: 'x',
    appOrigin: 'https://solco.test',
    redirectUri: 'https://solco.test/api/spotify/callback',
    secureCookies: true,
  };
  mocks.user = { id: 'u1' };
  mocks.authFails = false;
  mocks.limited = null;
  mocks.auth = { accessToken: 'tok' };
  mocks.sync = { updated: [], failed: [], nothingToSync: true };
  mocks.deleteConnection.mockClear();
});

describe('POST /api/spotify/sync', () => {
  it('403 su origine diversa', async () => {
    mocks.sameOrigin = false;
    expect((await POST(req())).status).toBe(403);
  });

  it('404 quando Spotify non è configurato', async () => {
    mocks.config = null;
    expect((await POST(req())).status).toBe(404);
  });

  it('401 se non autenticato', async () => {
    mocks.authFails = true;
    expect((await POST(req())).status).toBe(401);
  });

  it('401 quando il collegamento Spotify non è valido', async () => {
    mocks.auth = null;
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('spotify_reauth');
  });

  it('200 e nothingToSync quando non c’è nulla di importato', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ updated: [], failed: [], nothingToSync: true });
  });

  it('200 con le playlist aggiornate (specchio esatto)', async () => {
    mocks.sync = { updated: [entry], failed: [], nothingToSync: false };
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated[0]).toMatchObject({ source: 'saved', added: 3, removed: 1 });
  });

  it('dimentica i token quando la sync segnala spotify_reauth', async () => {
    mocks.sync = {
      updated: [],
      failed: [{ source: 'saved', error: 'spotify_reauth', message: 'Ricollega Spotify.' }],
      nothingToSync: false,
    };
    await POST(req());
    expect(mocks.deleteConnection).toHaveBeenCalledWith('u1');
  });
});
