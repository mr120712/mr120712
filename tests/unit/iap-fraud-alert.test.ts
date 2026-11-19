// @polsia:user-owned — unit dell'avviso di frode IAP: log sempre, Telegram solo se ci sono chat admin,
// mai lancia. Telegram è import pigro, qui mockato.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { sendTelegramMessage } = vi.hoisted(() => ({
  sendTelegramMessage: vi.fn<
    (chatId: string, text: string, options?: Record<string, unknown>) => Promise<boolean>
  >(async () => true),
}));
vi.mock('@/lib/business/telegram-bot.server', () => ({ sendTelegramMessage }));

import { reportIapFraudSignal } from '@/lib/business/iap/fraud-alert.server';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sendTelegramMessage.mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

const signal = {
  reason: 'account_mismatch' as const,
  platform: 'google' as const,
  userId: 'user-9',
  productId: 'solco_premium_monthly',
};

describe('reportIapFraudSignal', () => {
  it('registra sempre un log [iap-fraud] senza token né segreti', async () => {
    await reportIapFraudSignal(signal, {});
    expect(warn).toHaveBeenCalledWith('[iap-fraud]', expect.stringContaining('account_mismatch'));
    const logged = String(warn.mock.calls[0]?.[1]);
    expect(logged).toContain('user-9');
    expect(logged).not.toContain('ptoken');
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('avvisa ogni chat admin configurata (SKYNET_TELEGRAM_CHAT_IDS)', async () => {
    await reportIapFraudSignal(signal, { SKYNET_TELEGRAM_CHAT_IDS: '111, 222 , bad, 333' });
    // '111','222','333' sono validi; 'bad' scartato.
    expect(sendTelegramMessage).toHaveBeenCalledTimes(3);
    const call = sendTelegramMessage.mock.calls[0];
    expect(call?.[0]).toBe('111');
    expect(call?.[1]).toContain('acquisto sospetto');
    expect(call?.[2]).toMatchObject({ parseMode: 'HTML' });
  });

  it('non lancia mai, anche se Telegram fallisce', async () => {
    sendTelegramMessage.mockRejectedValueOnce(new Error('telegram down'));
    await expect(
      reportIapFraudSignal(signal, { SKYNET_TELEGRAM_CHAT_IDS: '111' }),
    ).resolves.toBeUndefined();
  });
});
