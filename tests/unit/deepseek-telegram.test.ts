// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_COMMAND,
  deepseekFrame,
  deepseekTelegramMessages,
  splitForTelegram,
} from '@/lib/business/deepseek-telegram';

describe('/deepseek nel bot Telegram', () => {
  it('riconosce /deepseek, /ds e la forma @NomeBot, multilinea', () => {
    expect(DEEPSEEK_COMMAND.exec('/deepseek ciao')?.[1]).toBe('ciao');
    expect(DEEPSEEK_COMMAND.exec('/ds@SolcoBot riga 1\nriga 2')?.[1]).toBe('riga 1\nriga 2');
    expect(DEEPSEEK_COMMAND.exec('/DS')?.[1]).toBeUndefined();
    expect(DEEPSEEK_COMMAND.exec('/dsx ciao')).toBeNull();
    expect(DEEPSEEK_COMMAND.exec('/skynet ciao')).toBeNull();
  });

  it('spezza le risposte lunghe sotto il limite di Telegram, su confini naturali', () => {
    const text = Array.from({ length: 300 }, (_, i) => `Paragrafo ${i} ${'x'.repeat(40)}`).join(
      '\n\n',
    );
    const parts = splitForTelegram(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(3800);
    expect(parts.join('\n\n')).toBe(text);
    expect(splitForTelegram('y'.repeat(8000)).map((p) => p.length)).toEqual([3800, 3800, 400]);
  });

  it("fa l'escape HTML della risposta e spiega gli errori senza segreti", () => {
    expect(deepseekTelegramMessages({ status: 'ok', reply: '<b>a & b</b>', model: 'm' })).toEqual([
      '&lt;b&gt;a &amp; b&lt;/b&gt;',
    ]);
    const [notConfigured] = deepseekTelegramMessages({ status: 'not_configured' });
    expect(notConfigured).toContain('MWAPI_API_KEY');
    const [chat] = deepseekTelegramMessages({ status: 'failed', error: 'chat_not_configured' });
    expect(chat).toContain('DEEPSEEK_ENDPOINT_URL');
  });

  it("anima l'attesa con i secondi trascorsi", () => {
    expect(deepseekFrame(12_345, 2)).toBe('<b>🐋 DeepSeek</b> sta pensando..\n<i>12 s</i>');
  });
});
