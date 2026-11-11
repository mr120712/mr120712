// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/modules/file-upload/proxy', () => ({
  DownloadAuthorization: { Allow: 'allow', Deny: 'deny' },
}));

import { authorizeDownload } from '@/lib/file-upload/download-policy.server';

describe('accesso diretto ai file privati musicali', () => {
  it('nega il download generico: i byte passano solo dallo stream Solco Pro verificato', async () => {
    await expect(
      authorizeDownload(new Request('https://solco.test/api/files/private-key'), 'private-key'),
    ).resolves.toBe('deny');
  });
});
