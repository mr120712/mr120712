// @polsia:user-owned — avviso al ritorno (una volta per video), messaggi di errore del player e
// contatore degli ascolti gratuiti per fonte.
import { describe, expect, it } from 'vitest';
import {
  createReturnNoticeTracker,
  noteHiddenPause,
  takeReturnNotice,
  youtubeWatchUrl,
} from '@/lib/music/background-switch';
import {
  failureLink,
  failureMessage,
  LICENSE_NOT_ALLOWED_MESSAGE,
  showsFreePlayCounter,
} from '@/lib/music/player-messages';

function denied(reason: string, extra: Record<string, unknown> = {}) {
  return new Error(reason, { cause: { allowed: false, reason, ...extra } });
}

const audius = { playbackMode: 'audius', sourceUrl: 'https://audius.co/artista/brano' };

describe('avviso al ritorno: solo dopo una pausa dovuta alla pagina nascosta', () => {
  it('mostra l’avviso per il video fermato, se è ancora quello corrente', () => {
    const tracker = createReturnNoticeTracker();
    expect(takeReturnNotice(tracker, 'aaaaaaaaaaa')).toBeNull();
    noteHiddenPause(tracker, 'aaaaaaaaaaa');
    expect(takeReturnNotice(tracker, 'aaaaaaaaaaa')).toBe('aaaaaaaaaaa');
    // Consumed: a second "visible" event does not show it again.
    expect(takeReturnNotice(tracker, 'aaaaaaaaaaa')).toBeNull();
  });

  it('al massimo una volta per video', () => {
    const tracker = createReturnNoticeTracker();
    noteHiddenPause(tracker, 'aaaaaaaaaaa');
    expect(takeReturnNotice(tracker, 'aaaaaaaaaaa')).toBe('aaaaaaaaaaa');
    noteHiddenPause(tracker, 'aaaaaaaaaaa');
    expect(takeReturnNotice(tracker, 'aaaaaaaaaaa')).toBeNull();
    noteHiddenPause(tracker, 'bbbbbbbbbbb');
    expect(takeReturnNotice(tracker, 'bbbbbbbbbbb')).toBe('bbbbbbbbbbb');
  });

  it('niente avviso se nel frattempo è cambiato il brano', () => {
    const tracker = createReturnNoticeTracker();
    noteHiddenPause(tracker, 'aaaaaaaaaaa');
    expect(takeReturnNotice(tracker, 'bbbbbbbbbbb')).toBeNull();
    expect(takeReturnNotice(tracker, null)).toBeNull();
    noteHiddenPause(tracker, null);
    expect(takeReturnNotice(tracker, null)).toBeNull();
  });

  it('link YouTube solo per un id valido', () => {
    expect(youtubeWatchUrl('aaaaaaaaaaa')).toBe('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    expect(youtubeWatchUrl('x"><script>')).toBe('https://www.youtube.com/');
  });
});

describe('messaggi di errore del player', () => {
  it('licenza non consentita: si ascolta solo su Audius, con il link al brano', () => {
    const message = failureMessage(denied('license_not_allowed'), audius);
    expect(message).toBe(
      "L'artista ha scelto una licenza diversa: questo brano si ascolta solo su Audius.",
    );
    expect(message).toBe(LICENSE_NOT_ALLOWED_MESSAGE);
    expect(failureLink(message, audius)).toEqual({
      href: 'https://audius.co/artista/brano',
      label: 'Ascolta su Audius',
    });
    // No link without a safe Audius page, or for other messages.
    expect(failureLink(message, { ...audius, sourceUrl: null })).toBeNull();
    expect(failureLink(message, { ...audius, sourceUrl: 'javascript:alert(1)' })).toBeNull();
    expect(failureLink(message, { ...audius, sourceUrl: 'https://evil.example/x' })).toBeNull();
    expect(failureLink('Altro errore', audius)).toBeNull();
  });

  it('Jamendo è spento: messaggio neutro, nessuna promessa Premium', () => {
    const jamendo = { playbackMode: 'jamendo', sourceUrl: null };
    for (const error of [denied('premium_required'), denied('unauthorized'), null]) {
      const message = failureMessage(error, jamendo);
      expect(message).toBe('Questo brano non è disponibile al momento.');
      expect(message).not.toMatch(/Premium|Jamendo/);
    }
    expect(failureMessage(denied('premium_required'), audius)).not.toMatch(/Premium|Jamendo/);
  });

  it('mantiene i messaggi esistenti per gli altri motivi', () => {
    expect(failureMessage(denied('pro_required'), audius)).toContain('Solco Pro');
    expect(failureMessage(denied('not_streamable'), audius)).toBe(
      'Audius non autorizza lo streaming di questo brano.',
    );
    expect(failureMessage(denied('rate_limited', { retryAfterSeconds: 12 }), audius)).toContain(
      '12 secondi',
    );
    expect(failureMessage(null, { playbackMode: 'radio' })).toContain('stazione radio');
    expect(failureMessage(null, { playbackMode: 'podcast' })).toContain('episodio');
    expect(failureMessage(new Error('rete'), audius)).toContain('Nessun audio');
  });
});

describe('contatore "Ascolti gratuiti": solo per le fonti che lo usano', () => {
  it('Audius e podcast sì; radio e YouTube no', () => {
    expect(showsFreePlayCounter('audius')).toBe(true);
    expect(showsFreePlayCounter('solco')).toBe(true);
    expect(showsFreePlayCounter('podcast')).toBe(true);
    expect(showsFreePlayCounter('radio')).toBe(false);
    expect(showsFreePlayCounter('youtube')).toBe(false);
    expect(showsFreePlayCounter('song')).toBe(false);
    expect(showsFreePlayCounter('jamendo')).toBe(false);
    expect(showsFreePlayCounter(undefined)).toBe(false);
  });
});
