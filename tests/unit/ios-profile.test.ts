// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/site', () => ({ siteUrl: 'https://solcomusic.vercel.app' }));

import { GET } from '@/app/ios/solco.mobileconfig/route';
import { buildIosProfile } from '@/lib/business/ios-profile';

describe('profilo iOS', () => {
  it('crea una Web Clip a schermo intero verso il sito, rimovibile', () => {
    const xml = buildIosProfile('https://solcomusic.vercel.app');
    expect(xml).toContain('<string>com.apple.webClip.managed</string>');
    expect(xml).toContain('<string>https://solcomusic.vercel.app/</string>');
    expect(xml).toMatch(/<key>FullScreen<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>IsRemovable<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>Icon<\/key>\s*<data>iVBORw0KGgo/);
    expect(xml).toMatch(/<key>PayloadRemovalDisallowed<\/key>\s*<false\/>/);
  });

  it('usa il content type che apre l’installer di iOS', async () => {
    const response = GET();
    expect(response.headers.get('content-type')).toBe('application/x-apple-aspen-config');
    expect(await response.text()).toContain('<plist version="1.0">');
  });
});
