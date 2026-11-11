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

describe('accesso ai file amministrativi', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('consente upload e download solo a una sessione admin verificata', async () => {
    getSession.mockResolvedValue({
      user: { id: 'verified-admin', role: 'admin', emailVerified: true },
    });

    await expect(authorizeUpload(request)).resolves.toBe('allow');
    await expect(authorizeDownload(request, 'private/audio.wav')).resolves.toBe('allow');
  });

  it('nega account anonimi, non admin e admin non verificati', async () => {
    const deniedSessions = [
      null,
      { user: { id: 'member', role: 'user', emailVerified: true } },
      { user: { id: 'unverified-admin', role: 'admin', emailVerified: false } },
    ];

    for (const session of deniedSessions) {
      getSession.mockResolvedValueOnce(session);
      await expect(authorizeUpload(request)).resolves.toBe('deny');
      getSession.mockResolvedValueOnce(session);
      await expect(authorizeDownload(request, 'private/audio.wav')).resolves.toBe('deny');
    }
  });
});
