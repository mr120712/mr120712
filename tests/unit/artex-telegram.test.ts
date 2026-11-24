// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  ARTEX_COMMAND,
  ARTEX_TELEGRAM_CHUNK,
  artexChatMessages,
  artexChatStreamingFrame,
  artexStopMessages,
  artexTelegramMessages,
  extractArtexConversationId,
  parseArtexCommand,
} from '@/lib/business/artex-telegram';

describe('ARTEX_COMMAND', () => {
  it('matches the shapes the user types', () => {
    expect(ARTEX_COMMAND.exec('/artex')?.[1]).toBeUndefined();
    expect(ARTEX_COMMAND.exec('/artex status')?.[1]).toBe('status');
    expect(ARTEX_COMMAND.exec('/artex@SolcoBot status')?.[1]).toBe('status');
    expect(ARTEX_COMMAND.exec('/artex  stato  ')?.[1]).toBe('stato  ');
    expect(ARTEX_COMMAND.exec('/artexstatus')).toBeNull();
    expect(ARTEX_COMMAND.exec('/other status')).toBeNull();
  });
});

describe('parseArtexCommand', () => {
  it('maps the shapes to kinds', () => {
    expect(parseArtexCommand('')).toEqual({ kind: 'help' });
    expect(parseArtexCommand('   ')).toEqual({ kind: 'help' });
    expect(parseArtexCommand('status')).toEqual({ kind: 'status' });
    expect(parseArtexCommand('stato')).toEqual({ kind: 'status' });
    expect(parseArtexCommand('HELP')).toEqual({ kind: 'help' });
    expect(parseArtexCommand('?')).toEqual({ kind: 'help' });
    expect(parseArtexCommand('attack prod')).toEqual({ kind: 'unknown', subcommand: 'attack' });
  });

  it('ask/chat/chiedi forward the rest as a question', () => {
    expect(parseArtexCommand('ask What is open on the preview?')).toEqual({
      kind: 'ask',
      question: 'What is open on the preview?',
    });
    expect(parseArtexCommand('CHIEDI  come procede ')).toEqual({
      kind: 'ask',
      question: 'come procede',
    });
    expect(parseArtexCommand('chat  riassumi i findings')).toEqual({
      kind: 'ask',
      question: 'riassumi i findings',
    });
  });

  it('ask with no question nudges back to help instead of sending an empty prompt', () => {
    expect(parseArtexCommand('ask')).toEqual({ kind: 'help' });
    expect(parseArtexCommand('ask   ')).toEqual({ kind: 'help' });
  });

  it('stop/ferma/pausa require a numeric id', () => {
    expect(parseArtexCommand('stop 42')).toEqual({ kind: 'stop', taskId: '42' });
    expect(parseArtexCommand('FERMA 7 rest ignored')).toEqual({ kind: 'stop', taskId: '7' });
    expect(parseArtexCommand('pausa 1')).toEqual({ kind: 'stop', taskId: '1' });
    expect(parseArtexCommand('stop')).toEqual({ kind: 'help' });
    expect(parseArtexCommand('stop abc')).toEqual({ kind: 'help' });
  });
});

describe('extractArtexConversationId', () => {
  it('parses the conversation footer we embed in ARTEX replies', () => {
    expect(extractArtexConversationId('🛡️ ARTEX\npong\n\n· conversazione #42 ·')).toBe(42);
    expect(extractArtexConversationId('something conversazione #7 trailing')).toBe(7);
    expect(extractArtexConversationId('conv. #3')).toBe(3);
  });

  it('returns null for unrelated or empty text', () => {
    expect(extractArtexConversationId(null)).toBeNull();
    expect(extractArtexConversationId('')).toBeNull();
    expect(extractArtexConversationId('ciao')).toBeNull();
    expect(extractArtexConversationId('conversazione senza numero')).toBeNull();
  });
});

describe('artexStopMessages', () => {
  it('ok reports the paused task id', () => {
    const [msg] = artexStopMessages({ status: 'ok' }, 7);
    expect(msg).toContain('#7');
    expect(msg).toContain('pausa');
  });

  it('not_found is explicit', () => {
    const [msg] = artexStopMessages({ status: 'failed', error: 'not_found' }, '99');
    expect(msg).toContain('99');
    expect(msg).toContain('Nessun task');
  });

  it('bad_id tells the user to use a number', () => {
    const [msg] = artexStopMessages({ status: 'failed', error: 'bad_id' }, 'abc');
    expect(msg).toContain('numero');
  });
});

describe('artexChatStreamingFrame', () => {
  it('wraps a partial answer with the thinking footer and escapes html', () => {
    const frame = artexChatStreamingFrame('hello <there>');
    expect(frame).toContain('🛡️ <b>ARTEX</b>');
    expect(frame).toContain('hello &lt;there&gt;');
    expect(frame).toContain('in corso');
  });

  it('keeps the frame under the Telegram chunk even on a long partial', () => {
    const blob = 'x'.repeat(ARTEX_TELEGRAM_CHUNK * 2);
    const frame = artexChatStreamingFrame(blob);
    expect(frame.length).toBeLessThanOrEqual(ARTEX_TELEGRAM_CHUNK + 100);
  });
});

describe('artexTelegramMessages', () => {
  it('not_configured gives a clear owner-facing error', () => {
    const [msg] = artexTelegramMessages({ status: 'not_configured' });
    expect(msg).toMatch(/ARTEX non è collegato/);
    expect(msg).toContain('ARTEX_URL');
    expect(msg).toContain('ARTEX_PASSWORD');
  });

  it('unauthorized says the password or reachability is wrong', () => {
    const [msg] = artexTelegramMessages({
      status: 'failed',
      error: 'unauthorized',
      detail: 'login_401',
    });
    expect(msg).toContain('Password ARTEX sbagliata');
  });

  it('unreachable says the VPS or Caddy is not serving', () => {
    const [msg] = artexTelegramMessages({ status: 'failed', error: 'unreachable' });
    expect(msg).toContain('Caddy');
  });

  it('ok renders tasks, findings and tokens', () => {
    const [msg] = artexTelegramMessages({
      status: 'ok',
      data: {
        tasks: { total: 7, running: 2 },
        findings: { total: 15, bySeverity: { high: 3, medium: 7, low: 5 } },
        tokensToday: 125_000,
      },
    });
    expect(msg).toContain('Task in esecuzione: <b>2</b>');
    expect(msg).toContain('Findings: <b>15</b>');
    expect(msg).toContain('high: 3');
    expect(msg).toContain('medium: 7');
    expect(msg).toContain('low: 5');
    // severity is sorted critical→high→medium→low→info
    const text = msg ?? '';
    expect(text.indexOf('high: 3')).toBeLessThan(text.indexOf('medium: 7'));
    expect(text.indexOf('medium: 7')).toBeLessThan(text.indexOf('low: 5'));
    expect(msg).toMatch(/Token LLM oggi: <b>125[.,\s]000<\/b>/);
  });

  it('ok with zero findings reads cleanly', () => {
    const [msg] = artexTelegramMessages({
      status: 'ok',
      data: {
        tasks: { total: 0, running: 0 },
        findings: { total: 0, bySeverity: {} },
        tokensToday: null,
      },
    });
    expect(msg).toContain('Task totali: <b>0</b>');
    expect(msg).toContain('Findings: nessuno ancora');
    expect(msg).not.toContain('Token LLM oggi');
  });
});

describe('artexChatMessages', () => {
  it('short reply fits in one message, HTML-escaped', () => {
    const parts = artexChatMessages({
      status: 'ok',
      reply: 'Hello <there> & welcome',
      conversationId: 7,
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain('🛡️ <b>ARTEX</b>');
    expect(parts[0]).toContain('Hello &lt;there&gt; &amp; welcome');
  });

  it('long reply splits on blank lines and stays under the Telegram limit', () => {
    // Build a reply with three paragraphs, each bigger than the chunk threshold.
    const para = 'x'.repeat(Math.floor(ARTEX_TELEGRAM_CHUNK * 0.6));
    const reply = [para, para, para].join('\n\n');
    const parts = artexChatMessages({ status: 'ok', reply, conversationId: 1 });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(ARTEX_TELEGRAM_CHUNK + 50);
    // Only the first part carries the header.
    expect(parts[0]).toContain('🛡️ <b>ARTEX</b>');
    for (const part of parts.slice(1)) expect(part).not.toContain('🛡️');
  });

  it('a single paragraph bigger than the chunk cap hard-slices', () => {
    const blob = 'a'.repeat(ARTEX_TELEGRAM_CHUNK * 2 + 10);
    const parts = artexChatMessages({ status: 'ok', reply: blob, conversationId: 1 });
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(ARTEX_TELEGRAM_CHUNK + 50);
  });

  it('not_configured, unauthorized, unreachable each have a readable message', () => {
    expect(artexChatMessages({ status: 'not_configured' })[0]).toContain('ARTEX non è collegato');
    expect(artexChatMessages({ status: 'failed', error: 'unauthorized' })[0]).toContain(
      'Password ARTEX',
    );
    expect(artexChatMessages({ status: 'failed', error: 'unreachable' })[0]).toContain('Caddy');
    expect(artexChatMessages({ status: 'failed', error: 'still_running' })[0]).toContain(
      'sta ancora pensando',
    );
    expect(artexChatMessages({ status: 'failed', error: 'empty_reply' })[0]).toContain(
      'senza una risposta',
    );
    expect(artexChatMessages({ status: 'failed', error: 'empty_question' })[0]).toContain(
      'domanda è vuota',
    );
  });

  it('ok ends with the conversation footer on the LAST chunk only', () => {
    const [onePart] = artexChatMessages({ status: 'ok', reply: 'short', conversationId: 42 });
    expect(onePart).toContain('conversazione #42');

    // Multi-chunk: footer must land on the last chunk, header on the first.
    const long = ['a'.repeat(3500), 'b'.repeat(3500)].join('\n\n');
    const parts = artexChatMessages({ status: 'ok', reply: long, conversationId: 99 });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toContain('🛡️ <b>ARTEX</b>');
    expect(parts[0]).not.toContain('conversazione #99');
    expect(parts[parts.length - 1]).toContain('conversazione #99');
  });

  it('failed with a conversationId still carries the footer so retries thread', () => {
    const [msg] = artexChatMessages({
      status: 'failed',
      error: 'still_running',
      conversationId: 5,
    });
    expect(msg).toContain('conversazione #5');
  });

  it('round-trips: footer embedded on reply → parsed back out by extractArtexConversationId', () => {
    const [sent] = artexChatMessages({ status: 'ok', reply: 'pong', conversationId: 123 });
    expect(extractArtexConversationId(sent ?? null)).toBe(123);
  });
});
