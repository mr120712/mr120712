// @polsia:user-owned — invio con effetto 🎉 (message_effect_id) e messaggi modificabili del bot
// Telegram: l'effetto va nella richiesta, un effetto rifiutato fa ripartire l'invio senza, il
// message_id torna al chiamante. Rete finta.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: { TELEGRAM_BOT_TOKEN: 'test-bot-token' } }));

import {
  editTelegramMessage,
  sendTelegramMessageId,
  sendTelegramVideo,
  TELEGRAM_EFFECT_PARTY,
} from '@/lib/business/telegram-bot.server';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const reply = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const sentBody = (i: number) => JSON.parse(String(fetchMock.mock.calls[i]?.[1]?.body));

describe('effetto 🎉 e messaggi modificabili', () => {
  it('sendTelegramVideo manda message_effect_id', async () => {
    fetchMock.mockResolvedValue(reply({ ok: true }));
    await expect(
      sendTelegramVideo('7', 'https://w.example/v.mp4', { effectId: TELEGRAM_EFFECT_PARTY }),
    ).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/sendVideo$/);
    expect(sentBody(0).message_effect_id).toBe(TELEGRAM_EFFECT_PARTY);
  });

  it('effetto rifiutato → reinvio senza effetto; altro errore → nessun secondo download', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ ok: false, description: 'Bad Request: EFFECT_ID_INVALID' }))
      .mockResolvedValueOnce(reply({ ok: true }));
    await expect(
      sendTelegramVideo('7', 'https://w.example/v.mp4', { effectId: TELEGRAM_EFFECT_PARTY }),
    ).resolves.toBe(true);
    expect(sentBody(1).message_effect_id).toBeUndefined();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply({ ok: false, description: 'Bad Request: file is too big' }));
    await expect(
      sendTelegramVideo('7', 'https://w.example/v.mp4', { effectId: TELEGRAM_EFFECT_PARTY }),
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sendTelegramMessageId restituisce il message_id; editTelegramMessage accetta «not modified»', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, result: { message_id: 99 } }));
    await expect(sendTelegramMessageId('7', 'ciao')).resolves.toBe(99);

    fetchMock.mockResolvedValueOnce(
      reply({ ok: false, description: 'Bad Request: message is not modified' }),
    );
    await expect(editTelegramMessage('7', 99, 'ciao')).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/editMessageText$/);
    expect(sentBody(1)).toMatchObject({ chat_id: '7', message_id: 99, text: 'ciao' });
  });
});
