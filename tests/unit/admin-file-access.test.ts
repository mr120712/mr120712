// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession } } }));
vi.mock('@/modules/file-upload/proxy', () => ({
  UploadAuthorization: { Allow: 'allow', Deny: 'deny' },
  DownloadAuthorization: { Allow: 'allow', Deny: 'deny' },
}));

import { authorizeDownload } from '@/lib/file-upload/download-policy.server';
import { authorizeUpload } from '@/lib/file-upload/policy.server';

const request = new Request('https://solco.test/api/upload');

describe('autorizzazione upload/download dei file', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('consente l’upload solo a un admin verificato', async () => {
    getSession.mockResolvedValue({
      user: { id: 'verified-admin', role: 'admin', emailVerified: true },
    });
    await expect(authorizeUpload(request)).resolves.toBe('allow');
  });

  it('nega l’upload ad anonimi, utenti e admin non verificati', async () => {
    const deniedSessions = [
      null,
      { user: { id: 'member', role: 'user', emailVerified: true } },
      { user: { id: 'unverified-admin', role: 'admin', emailVerified: false } },
    ];

    for (const session of deniedSessions) {
      getSession.mockResolvedValueOnce(session);
      await expect(authorizeUpload(request)).resolves.toBe('deny');
    }
  });

  it('nega SEMPRE il download generico /api/files (le registrazioni usano la route dedicata owner-gated)', async () => {
    const sessions = [
      null,
      { user: { id: 'member', role: 'user', emailVerified: true } },
      { user: { id: 'verified-admin', role: 'admin', emailVerified: true } },
    ];

    for (const session of sessions) {
      getSession.mockResolvedValueOnce(session);
      await expect(authorizeDownload(request, 'private/audio.wav')).resolves.toBe('deny');
    }
  });
});
