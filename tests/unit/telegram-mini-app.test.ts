// @polsia:user-owned
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isTelegramLaunch,
  isTelegramMiniAppConfigured,
  telegramMiniAppLink,
} from '@/lib/telegram-mini-app';

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

describe('isTelegramLaunch (rilevamento Mini App)', () => {
  it('vero quando l’SDK ha già i dati di init', () => {
    expect(isTelegramLaunch('', { initData: 'query_id=abc' })).toBe(true);
  });

  it('vero quando l’SDK espone una piattaforma nota', () => {
    expect(isTelegramLaunch('', { platform: 'android' })).toBe(true);
    expect(isTelegramLaunch('', { platform: 'unknown' })).toBe(false);
  });

  it('vero quando il fragment porta i parametri di avvio della Mini App', () => {
    expect(isTelegramLaunch('#tgWebAppData=xxx&tgWebAppVersion=7.0', undefined)).toBe(true);
    expect(isTelegramLaunch('#tgWebAppPlatform=ios', undefined)).toBe(true);
  });

  it('falso in un browser normale (nessun SDK, nessun fragment Telegram)', () => {
    expect(isTelegramLaunch('', undefined)).toBe(false);
    expect(isTelegramLaunch('#section=premi', { initData: '' })).toBe(false);
  });
});
