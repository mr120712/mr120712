// @polsia:user-owned — l'effetto di download del bot Telegram: fotogrammi della barra, animazione
// durante il lavoro, chiusura con ✅/❌ e ripiego se Telegram non collabora. Telegram è finto.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const tg = vi.hoisted(() => ({
  sendId: vi.fn(),
  send: vi.fn(),
  edit: vi.fn(),
  action: vi.fn(),
}));

vi.mock('@/lib/business/telegram-bot.server', () => ({
  sendTelegramMessageId: tg.sendId,
  sendTelegramMessage: tg.send,
  editTelegramMessage: tg.edit,
  sendTelegramChatAction: tg.action,
}));

import {
  doneFrame,
  finishProgress,
  progressBar,
  progressFrame,
  progressPercent,
  withDownloadProgress,
} from '@/lib/business/telegram-progress.server';

beforeEach(() => {
  vi.clearAllMocks();
  tg.sendId.mockResolvedValue(42);
  tg.send.mockResolvedValue(true);
  tg.edit.mockResolvedValue(true);
  tg.action.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('fotogrammi', () => {
  it('la barra ha sempre 10 celle', () => {
    expect(progressBar(0)).toBe('▱▱▱▱▱▱▱▱▱▱');
    expect(progressBar(50)).toBe('▰▰▰▰▰▱▱▱▱▱');
    expect(progressBar(100)).toBe('▰▰▰▰▰▰▰▰▰▰');
    expect(progressBar(250)).toHaveLength(10);
  });

  it('la percentuale cresce, rallenta e non arriva al 100% prima della fine', () => {
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(3000)).toBe(22);
    expect(progressPercent(8000)).toBe(49);
    expect(progressPercent(22_000)).toBe(84);
    expect(progressPercent(10 * 60_000)).toBe(92);
  });

  it('fasi in ordine e spinner che gira', () => {
    expect(progressFrame(1000, 0)).toMatch(/^🔎 Cerco il video… ◐\n/);
    expect(progressFrame(5000, 1)).toMatch(/^📡 Mi collego alla fonte… ◓/);
    expect(progressFrame(15_000, 2)).toMatch(/^⬇️ Scarico… ◑/);
    expect(progressFrame(40_000, 3)).toMatch(/^🎞️ Preparo il file… ◒/);
    expect(doneFrame(12_400)).toBe('✅ Pronto in 12 s\n▰▰▰▰▰▰▰▰▰▰ 100%');
  });
});

describe('withDownloadProgress', () => {
  it('anima un solo messaggio mentre il lavoro gira, poi si ferma', async () => {
    vi.useFakeTimers();
    let clock = 0;
    let finish: (v: string) => void = () => {};
    const task = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const run = withDownloadProgress('7', () => task, { intervalMs: 2000, now: () => clock });
    await vi.advanceTimersByTimeAsync(0);
    expect(tg.sendId).toHaveBeenCalledWith('7', expect.stringContaining('🔎 Cerco il video'));
    expect(tg.action).toHaveBeenCalledWith('7', 'upload_video');

    for (let i = 0; i < 4; i += 1) {
      clock += 2000;
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(tg.edit).toHaveBeenCalledTimes(4);
    expect(tg.edit.mock.calls.every((call) => call[1] === 42)).toBe(true);
    expect(String(tg.edit.mock.calls.at(-1)?.[2])).toContain('⬇️ Scarico'); // 8 s: fase «Scarico»
    expect(tg.action).toHaveBeenCalledTimes(3); // all'avvio, poi ogni due giri

    clock += 500;
    finish('ok');
    const result = await run;
    expect(result).toEqual({ value: 'ok', messageId: 42, elapsedMs: 8500 });
    const edits = tg.edit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tg.edit).toHaveBeenCalledTimes(edits); // niente modifiche dopo la fine
    expect(tg.send).not.toHaveBeenCalled();
  });

  it('se Telegram non dà il message_id: un messaggio di attesa, nessuna modifica', async () => {
    tg.sendId.mockResolvedValue(null);
    const result = await withDownloadProgress('7', async () => 5);
    expect(result.messageId).toBeNull();
    expect(tg.send).toHaveBeenCalledWith('7', expect.stringContaining('Cerco e preparo il video'));
    expect(tg.edit).not.toHaveBeenCalled();
  });

  it('un errore di Telegram non ferma il download; un errore del lavoro risale e ferma il timer', async () => {
    tg.sendId.mockRejectedValue(new Error('rete giù'));
    tg.action.mockRejectedValue(new Error('rete giù'));
    await expect(withDownloadProgress('7', async () => 'fatto')).resolves.toMatchObject({
      value: 'fatto',
    });
    vi.useFakeTimers();
    tg.sendId.mockResolvedValue(42);
    const failing = withDownloadProgress('7', async () => {
      throw new Error('worker giù');
    });
    await expect(failing).rejects.toThrow('worker giù');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tg.edit).not.toHaveBeenCalled();
  });
});

describe('finishProgress', () => {
  it('trasforma il messaggio di avanzamento', async () => {
    await expect(finishProgress('7', 42, '✅ fatto')).resolves.toBe(true);
    expect(tg.edit).toHaveBeenCalledWith('7', 42, '✅ fatto', {});
    expect(tg.send).not.toHaveBeenCalled();
  });

  it('senza message_id o con modifica rifiutata, manda un messaggio nuovo', async () => {
    await finishProgress('7', null, '❌ no', { parseMode: 'HTML' });
    expect(tg.send).toHaveBeenCalledWith('7', '❌ no', { parseMode: 'HTML' });
    tg.edit.mockResolvedValue(false);
    tg.send.mockClear();
    await finishProgress('7', 42, '❌ no');
    expect(tg.send).toHaveBeenCalledWith('7', '❌ no', {});
  });
});
