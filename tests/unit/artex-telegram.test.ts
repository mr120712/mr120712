// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  ARTEX_COMMAND,
  artexTelegramMessages,
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
