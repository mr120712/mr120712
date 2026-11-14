// @polsia:user-owned
// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { inviteUrlForCode, publicRewardsUrl, publicSiteUrl } from '@/lib/public-links';

const KEY = 'NEXT_PUBLIC_INVITE_BASE_URL';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(process.env, KEY);
  else process.env[KEY] = original;
});

describe('link pubblici per gli inviti', () => {
  it('di default puntano a www.solcomusic.online (niente redirect dal dominio nudo)', () => {
    Reflect.deleteProperty(process.env, KEY);
    expect(publicSiteUrl()).toBe('https://www.solcomusic.online');
    expect(inviteUrlForCode('ABC123')).toBe('https://www.solcomusic.online/invito/ABC123');
    expect(publicRewardsUrl()).toBe('https://www.solcomusic.online/premi');
  });

  it('accettano un override https valido (ne usano solo l’origine)', () => {
    process.env[KEY] = 'https://solco.example/qualcosa/';
    expect(inviteUrlForCode('X1')).toBe('https://solco.example/invito/X1');
  });

  it('ignorano override non https, con credenziali o malformati', () => {
    for (const bad of ['http://solco.example', 'https://u:p@solco.example', 'non-un-url']) {
      process.env[KEY] = bad;
      expect(publicSiteUrl()).toBe('https://www.solcomusic.online');
    }
  });

  it('codificano il codice nel percorso', () => {
    Reflect.deleteProperty(process.env, KEY);
    expect(inviteUrlForCode('a/b?c')).toBe('https://www.solcomusic.online/invito/a%2Fb%3Fc');
  });
});
