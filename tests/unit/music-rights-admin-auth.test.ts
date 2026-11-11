// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));

import { requireVerifiedMusicRightsAdmin } from '@/lib/music/rights-admin.server';

const request = new Request('https://solco.test/api/admin/music-rights');

beforeEach(() => vi.resetAllMocks());

describe('autorizzazione amministrativa dei diritti musicali', () => {
  it('nega sessioni assenti con 401 e ruoli non admin o non verificati con 403', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    const anonymous = await requireVerifiedMusicRightsAdmin(request);
    expect(anonymous.allowed).toBe(false);
    if (!anonymous.allowed) expect(anonymous.response.status).toBe(401);

    mocks.getSession.mockResolvedValueOnce({ user: { id: 'member-1', role: 'user', emailVerified: true } });
    const member = await requireVerifiedMusicRightsAdmin(request);
    expect(member.allowed).toBe(false);
    if (!member.allowed) expect(member.response.status).toBe(403);

    mocks.getSession.mockResolvedValueOnce({ user: { id: 'admin-1', role: 'admin', emailVerified: false } });
    const unverifiedAdmin = await requireVerifiedMusicRightsAdmin(request);
    expect(unverifiedAdmin.allowed).toBe(false);
    if (!unverifiedAdmin.allowed) expect(unverifiedAdmin.response.status).toBe(403);
  });

  it('accetta solo la sessione server-side di admin verificato e chiude in caso di errore auth', async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'admin-1', role: 'admin', emailVerified: true } });
    expect(await requireVerifiedMusicRightsAdmin(request)).toEqual({
      allowed: true,
      user: { id: 'admin-1' },
    });

    mocks.getSession.mockRejectedValueOnce(new Error('session store unavailable'));
    const unavailable = await requireVerifiedMusicRightsAdmin(request);
    expect(unavailable.allowed).toBe(false);
    if (!unavailable.allowed) expect(unavailable.response.status).toBe(503);
  });
});
