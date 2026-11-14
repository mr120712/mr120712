// @polsia:user-owned
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTelegramMiniAppConfigured, telegramMiniAppLink } from '@/lib/telegram-mini-app';

afterEach(() => vi.unstubAllEnvs());

describe('telegramMiniAppLink', () => {
  it('null quando il bot non è configurato', () => {
    vi.stubEnv('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', '');
    expect(isTelegramMiniAppConfigured()).toBe(false);
    expect(telegramMiniAppLink()).toBeNull();
    expect(telegramMiniAppLink('premi')).toBeNull();
  });

  it('link diretto startapp con lo username (toglie la @)', () => {
    vi.stubEnv('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', '@Solcomusicbot');
    expect(isTelegramMiniAppConfigured()).toBe(true);
    expect(telegramMiniAppLink()).toBe('https://t.me/Solcomusicbot?startapp');
  });

  it('aggiunge un parametro di avvio valido', () => {
    vi.stubEnv('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', 'Solcomusicbot');
    expect(telegramMiniAppLink('premi')).toBe('https://t.me/Solcomusicbot?startapp=premi');
  });

  it('ignora un parametro con caratteri non ammessi', () => {
    vi.stubEnv('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', 'Solcomusicbot');
    expect(telegramMiniAppLink('spazi e simboli!')).toBe('https://t.me/Solcomusicbot?startapp');
  });
});
