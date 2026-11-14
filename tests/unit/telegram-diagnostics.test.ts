// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  env: { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHANNEL_CHAT_ID: '9250292282' } as Record<
    string,
    string | undefined
  >,
}));
vi.mock('@/lib/env', () => ({ env: mocks.env }));
vi.mock('@/lib/site', () => ({ siteUrl: 'https://solco.test' }));

import { telegramBotDiagnostics } from '@/lib/business/telegram-bot.server';

function jsonRes(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

type Responders = { getMe?: unknown; getChat?: unknown; getChatMember?: unknown };
function stubTelegram(r: Responders) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.includes('/getMe')) return jsonRes(r.getMe);
      if (u.includes('/getChatMember')) return jsonRes(r.getChatMember);
      if (u.includes('/getChat')) return jsonRes(r.getChat);
      return jsonRes({ ok: false, description: 'unexpected' });
    }),
  );
}

beforeEach(() => {
  mocks.env = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHANNEL_CHAT_ID: '9250292282' };
});
afterEach(() => vi.unstubAllGlobals());

describe('telegramBotDiagnostics — avvisi di configurazione', () => {
  it('avvisa quando TELEGRAM_CHANNEL_CHAT_ID coincide con l’id del bot (e il bot non può postare)', async () => {
    stubTelegram({
      getMe: {
        ok: true,
        result: { id: 9250292282, username: 'Solcomusicbot', first_name: 'SolcoMusic' },
      },
      getChat: { ok: true, result: { id: 9250292282, type: 'private' } },
      getChatMember: { ok: true, result: { status: 'member' } },
    });
    const diag = await telegramBotDiagnostics();
    expect(diag.bot?.username).toBe('Solcomusicbot');
    expect(diag.membership?.canPost).toBeNull();
    expect(diag.errors).toEqual([]);
    expect(diag.warnings.some((w) => w.includes('id del bot'))).toBe(true);
    expect(diag.warnings.some((w) => w.includes('non può pubblicare'))).toBe(true);
  });

  it('nessun avviso quando il canale è giusto e il bot è amministratore che può postare', async () => {
    mocks.env.TELEGRAM_CHANNEL_CHAT_ID = '-1001234567890';
    stubTelegram({
      getMe: { ok: true, result: { id: 111, username: 'Solcomusicbot', first_name: 'SolcoMusic' } },
      getChat: { ok: true, result: { id: -1001234567890, type: 'channel', title: 'Solco' } },
      getChatMember: { ok: true, result: { status: 'administrator', can_post_messages: true } },
    });
    const diag = await telegramBotDiagnostics();
    expect(diag.membership?.canPost).toBe(true);
    expect(diag.channel.type).toBe('channel');
    expect(diag.warnings).toEqual([]);
  });

  it('avvisa quando la chat non è un canale (es. un gruppo)', async () => {
    mocks.env.TELEGRAM_CHANNEL_CHAT_ID = '-100999';
    stubTelegram({
      getMe: { ok: true, result: { id: 111, username: 'b', first_name: 'B' } },
      getChat: { ok: true, result: { id: -100999, type: 'group' } },
      getChatMember: { ok: true, result: { status: 'administrator', can_post_messages: true } },
    });
    const diag = await telegramBotDiagnostics();
    expect(diag.warnings.some((w) => w.includes('non è un canale'))).toBe(true);
  });
});
