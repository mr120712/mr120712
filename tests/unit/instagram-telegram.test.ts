// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import {
  INSTAGRAM_COMMAND,
  instagramTelegramMessages,
  parseInstagramCommand,
} from '@/lib/business/instagram-telegram';

describe('/ig nel bot', () => {
  it('riconosce /ig, /instagram e /ig@Bot', () => {
    expect(INSTAGRAM_COMMAND.exec('/ig lofi')?.[1]).toBe('lofi');
    expect(INSTAGRAM_COMMAND.exec('/instagram@SolcoBot lofi')?.[1]).toBe('lofi');
    expect(INSTAGRAM_COMMAND.test('/igx lofi')).toBe(false);
  });

  it('estrae hashtag, username e follower dalla frase', () => {
    expect(parseInstagramCommand('rapper romani 10k+ #trap #roma @a.b.')).toEqual({
      brief: 'rapper romani',
      hashtags: ['trap', 'roma'],
      usernames: ['a.b'],
      minFollowers: 10_000,
    });
    expect(parseInstagramCommand('dj house 1.5k - 2m follower')).toMatchObject({
      brief: 'dj house',
      minFollowers: 1_500,
      maxFollowers: 2_000_000,
    });
    // Intervallo al contrario: si tiene solo il minimo.
    expect(parseInstagramCommand('dj house 100k-5k').maxFollowers).toBeUndefined();
  });

  it('errori leggibili, con il dettaglio di Meta in <code> e HTML escapato', () => {
    expect(instagramTelegramMessages({ ok: false, error: 'auth', detail: 'Bad <token>' })).toEqual([
      '❌ Instagram: Meta rifiuta il token (scaduto o revocato): generane uno nuovo di lunga durata.\n<code>Bad &lt;token&gt;</code>',
    ]);
  });

  it('nessun creator: lo dice con un consiglio', () => {
    const [message] = instagramTelegramMessages({
      ok: true,
      result: {
        summary: 'x',
        hashtags: [],
        creators: [],
        posts: [],
        checked: 0,
        skipped: 0,
        aiRanked: false,
        warnings: ['Nessun creator menzionato'],
      },
    });
    expect(message).toContain('Nessun creator adatto');
    expect(message).toContain('⚠️ Nessun creator menzionato');
  });
});
