// @polsia:user-owned
import { describe, expect, it, vi } from 'vitest';
import {
  declarePlaybackSession,
  primeMediaElement,
  releasePlaybackSession,
  setAudioSessionType,
} from '@/lib/music/audio-session';
import {
  createListeningClock,
  LISTEN_MAX_BACKLOG_SECONDS,
  observeListening,
  restartListeningSample,
  restoreListening,
} from '@/lib/music/listening-time';
import {
  applyPositionState,
  artworkSize,
  FALLBACK_ARTWORK,
  mediaArtwork,
  mediaPositionState,
  mediaSessionActionPlan,
  mediaSessionKind,
  seekMediaElement,
  seekTargetSeconds,
} from '@/lib/music/media-session';
import {
  decideAdvance,
  isReplay,
  pickNextIndex,
  predictPlayBlock,
  rememberStart,
  rightsVerdictFromReason,
  shouldPrefetchNext,
} from '@/lib/music/playback-prefetch';

describe('controlli di sistema per tipo di contenuto (Media Session)', () => {
  it('riconosce musica, podcast, radio e video', () => {
    expect(mediaSessionKind('audius')).toBe('music');
    expect(mediaSessionKind('solco')).toBe('music');
    expect(mediaSessionKind('jamendo')).toBe('music');
    expect(mediaSessionKind('podcast')).toBe('podcast');
    expect(mediaSessionKind('radio')).toBe('radio');
    expect(mediaSessionKind('youtube')).toBe('video');
    expect(mediaSessionKind('song')).toBe('video');
  });

  it('musica: precedente/successivo, mai i salti ±secondi (su iOS li sostituirebbero)', () => {
    const plan = mediaSessionActionPlan({ kind: 'music', hasNext: true, hasPrevious: false });
    expect(plan).toMatchObject({
      play: true,
      pause: true,
      stop: true,
      previoustrack: true,
      nexttrack: true,
      seekto: true,
      seekbackward: false,
      seekforward: false,
    });
    expect(
      mediaSessionActionPlan({ kind: 'music', hasNext: false, hasPrevious: true }).nexttrack,
    ).toBe(false);
  });

  it('podcast: indietro/avanti di qualche secondo e cursore, niente cambio episodio', () => {
    expect(
      mediaSessionActionPlan({ kind: 'podcast', hasNext: true, hasPrevious: true }),
    ).toMatchObject({
      seekbackward: true,
      seekforward: true,
      seekto: true,
      previoustrack: false,
      nexttrack: false,
    });
  });

  it('radio: nessun cursore né salto; cambio stazione solo se ce ne sono altre', () => {
    const single = mediaSessionActionPlan({ kind: 'radio', hasNext: false, hasPrevious: false });
    expect(single).toMatchObject({
      seekto: false,
      seekbackward: false,
      seekforward: false,
      previoustrack: false,
      nexttrack: false,
      play: true,
      pause: true,
    });
    const zapping = mediaSessionActionPlan({ kind: 'radio', hasNext: true, hasPrevious: true });
    expect(zapping.previoustrack && zapping.nexttrack).toBe(true);
  });

  it('video: nessun salto né cursore', () => {
    const plan = mediaSessionActionPlan({ kind: 'video', hasNext: true, hasPrevious: true });
    expect(plan.seekto || plan.seekbackward || plan.seekforward).toBe(false);
  });

  it('calcola il seek: 15 s indietro e 30 avanti di default, entro i limiti del brano', () => {
    const media = { currentTime: 100, duration: 120 };
    expect(seekTargetSeconds('seekbackward', {}, media)).toBe(85);
    expect(seekTargetSeconds('seekforward', {}, media)).toBe(120);
    expect(seekTargetSeconds('seekbackward', { seekOffset: 10 }, media)).toBe(90);
    expect(seekTargetSeconds('seekbackward', {}, { currentTime: 5, duration: 120 })).toBe(0);
    expect(seekTargetSeconds('seekto', { seekTime: 42 }, media)).toBe(42);
    expect(seekTargetSeconds('seekto', { seekTime: 500 }, media)).toBe(120);
    expect(seekTargetSeconds('seekto', {}, media)).toBeNull();
  });

  it('usa fastSeek per i trascinamenti rapidi quando esiste', () => {
    const fastSeek = vi.fn();
    const media = { currentTime: 0, fastSeek };
    seekMediaElement(media, 30, true);
    expect(fastSeek).toHaveBeenCalledWith(30);
    expect(media.currentTime).toBe(0);
    seekMediaElement(media, 40, false);
    expect(media.currentTime).toBe(40);
    const plain = { currentTime: 0 };
    seekMediaElement(plain, 12, true);
    expect(plain.currentTime).toBe(12);
  });
});

describe('stato di posizione per il cursore di sistema', () => {
  it('usa la durata e la velocità dell’elemento, con la posizione entro la durata', () => {
    expect(
      mediaPositionState({ duration: 200, currentTime: 250, playbackRate: 1.5, live: false }),
    ).toEqual({ duration: 200, position: 200, playbackRate: 1.5 });
  });

  it('niente cursore per dirette, durata ignota o infinita; mai playbackRate 0', () => {
    expect(
      mediaPositionState({ duration: Infinity, currentTime: 3, playbackRate: 1, live: false }),
    ).toBeNull();
    expect(
      mediaPositionState({ duration: Number.NaN, currentTime: 0, playbackRate: 1, live: false }),
    ).toBeNull();
    expect(
      mediaPositionState({ duration: 300, currentTime: 3, playbackRate: 1, live: true }),
    ).toBeNull();
    expect(
      mediaPositionState({ duration: 300, currentTime: 3, playbackRate: 0, live: false })
        ?.playbackRate,
    ).toBe(1);
  });

  it('azzera con una chiamata senza argomenti e ignora gli errori del browser', () => {
    const setPositionState = vi.fn();
    applyPositionState({ setPositionState }, null);
    expect(setPositionState).toHaveBeenCalledWith();
    const throwing = vi.fn(() => {
      throw new TypeError('The provided value is non-finite');
    });
    expect(() =>
      applyPositionState(
        { setPositionState: throwing },
        { duration: 1, position: 0, playbackRate: 1 },
      ),
    ).not.toThrow();
    expect(() => applyPositionState(null, null)).not.toThrow();
  });
});

describe('copertine per schermata di blocco e notifica', () => {
  it('dichiara la dimensione reale ricavata dall’URL', () => {
    expect(artworkSize('https://creatornode.audius.co/content/Qm/480x480.jpg')).toBe(480);
    expect(artworkSize('https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg')).toBe(600);
    expect(artworkSize('https://usercontent.jamendo.com?type=album&id=1&width=300')).toBe(300);
    expect(artworkSize('https://radio.example/favicon.ico')).toBeNull();
    expect(mediaArtwork('https://creatornode.audius.co/content/Qm/480x480.jpg')).toEqual([
      {
        src: 'https://creatornode.audius.co/content/Qm/480x480.jpg',
        sizes: '480x480',
        type: 'image/jpeg',
      },
    ]);
  });

  it('senza dimensione nota non inventa sizes; senza copertina usa le icone PNG di Solco', () => {
    expect(mediaArtwork('https://radio.example/logo')).toEqual([
      { src: 'https://radio.example/logo' },
    ]);
    const fallback = mediaArtwork(null);
    expect(fallback).toEqual(FALLBACK_ARTWORK);
    expect(fallback.every((image) => image.type === 'image/png')).toBe(true);
    expect(fallback[0]?.sizes).toBe('512x512');
  });
});

describe('preparazione del brano successivo', () => {
  it('prepara ~20 secondi prima della fine, mai per le dirette o a durata ignota', () => {
    expect(shouldPrefetchNext({ duration: 200, currentTime: 179, live: false })).toBe(false);
    expect(shouldPrefetchNext({ duration: 200, currentTime: 181, live: false })).toBe(true);
    expect(shouldPrefetchNext({ duration: 10, currentTime: 0, live: false })).toBe(true);
    expect(shouldPrefetchNext({ duration: Infinity, currentTime: 0, live: false })).toBe(false);
    expect(shouldPrefetchNext({ duration: 200, currentTime: 199, live: true })).toBe(false);
  });

  it('in ordine: successivo, poi ritorno all’inizio solo con ripeti tutto', () => {
    const modes = ['audius', 'audius', 'audius'];
    expect(pickNextIndex({ modes, index: 0, shuffle: false, wrap: false, hidden: false })).toBe(1);
    expect(
      pickNextIndex({ modes, index: 2, shuffle: false, wrap: false, hidden: false }),
    ).toBeNull();
    expect(pickNextIndex({ modes, index: 2, shuffle: false, wrap: true, hidden: false })).toBe(0);
    expect(
      pickNextIndex({ modes: ['audius'], index: 0, shuffle: false, wrap: true, hidden: false }),
    ).toBe(0);
  });

  it('a pagina nascosta salta i video YouTube verso il primo brano ascoltabile', () => {
    const modes = ['audius', 'youtube', 'song', 'jamendo'];
    expect(pickNextIndex({ modes, index: 0, shuffle: false, wrap: false, hidden: true })).toBe(3);
    expect(pickNextIndex({ modes, index: 0, shuffle: false, wrap: false, hidden: false })).toBe(1);
    // Nothing audible ahead: the plain next item (the player defers it until Solco is visible).
    expect(
      pickNextIndex({
        modes: ['audius', 'youtube'],
        index: 0,
        shuffle: false,
        wrap: false,
        hidden: true,
      }),
    ).toBe(1);
  });

  it('in casuale non ripete il brano corrente e da nascosto sceglie solo audio', () => {
    const modes = ['audius', 'youtube', 'youtube', 'podcast'];
    for (const value of [0, 0.3, 0.6, 0.99]) {
      const visible = pickNextIndex({
        modes,
        index: 0,
        shuffle: true,
        wrap: false,
        hidden: false,
        random: () => value,
      });
      expect(visible).not.toBe(0);
      expect(
        pickNextIndex({
          modes,
          index: 0,
          shuffle: true,
          wrap: false,
          hidden: true,
          random: () => value,
        }),
      ).toBe(3);
    }
  });

  it('prevede il blocco Free come il server, senza contare i riascolti né YouTube e radio', () => {
    const free = { signedIn: true, premium: false, playsUsed: 40, playsLimit: 40 };
    expect(predictPlayBlock(free, { qualifiedId: 'audius:a', replay: false })).toBe(
      'monthly_limit',
    );
    expect(predictPlayBlock(free, { qualifiedId: 'audius:a', replay: true })).toBeNull();
    expect(
      predictPlayBlock(free, { qualifiedId: 'youtube:abcdefghijk', replay: false }),
    ).toBeNull();
    expect(predictPlayBlock(free, { qualifiedId: 'radio:s1', replay: false })).toBeNull();
    expect(
      predictPlayBlock({ ...free, playsUsed: 39 }, { qualifiedId: 'podcast:1~a', replay: false }),
    ).toBeNull();
    expect(
      predictPlayBlock({ ...free, premium: true }, { qualifiedId: 'audius:a', replay: false }),
    ).toBeNull();
    expect(
      predictPlayBlock({ ...free, signedIn: false }, { qualifiedId: 'radio:s1', replay: false }),
    ).toBe('login_required');
    expect(predictPlayBlock(null, { qualifiedId: 'audius:a', replay: false })).toBeNull();
  });

  it('ricorda il primo avvio della finestra di riascolto di 30 minuti', () => {
    const started = new Map<string, number>();
    rememberStart(started, 'audius:a', 0);
    rememberStart(started, 'audius:a', 20 * 60_000);
    expect(started.get('audius:a')).toBe(0);
    expect(isReplay(started, 'audius:a', 25 * 60_000)).toBe(true);
    expect(isReplay(started, 'audius:a', 30 * 60_000)).toBe(false);
    expect(isReplay(started, 'audius:b', 0)).toBe(false);
  });

  it('salta un brano solo per un rifiuto che riguarda il brano, non per errori temporanei', () => {
    expect(rightsVerdictFromReason('not_streamable')).toBe('denied');
    expect(rightsVerdictFromReason('pro_required')).toBe('denied');
    expect(rightsVerdictFromReason('rate_limited')).toBe('pending');
    expect(rightsVerdictFromReason('catalog_unavailable')).toBe('pending');
    expect(rightsVerdictFromReason(undefined)).toBe('pending');
  });

  it('decide il passaggio sincrono solo quando è sicuro', () => {
    const access = { signedIn: true, premium: false, playsUsed: 3, playsLimit: 40 };
    const base = { qualifiedId: 'audius:a', access, replay: false };
    expect(decideAdvance({ ...base, mode: 'audius', rights: 'allowed' })).toEqual({
      kind: 'switch',
    });
    // Audius never verified ahead: the normal path checks it first.
    expect(decideAdvance({ ...base, mode: 'audius', rights: null }).kind).toBe('async');
    expect(decideAdvance({ ...base, mode: 'solco', rights: 'pending' }).kind).toBe('async');
    expect(decideAdvance({ ...base, mode: 'audius', rights: 'denied' }).kind).toBe('denied');
    // Open streams need no rights check.
    expect(
      decideAdvance({ ...base, qualifiedId: 'podcast:1~a', mode: 'podcast', rights: null }).kind,
    ).toBe('switch');
    expect(
      decideAdvance({ ...base, qualifiedId: 'youtube:abcdefghijk', mode: 'youtube', rights: null })
        .kind,
    ).toBe('async');
    expect(
      decideAdvance({
        ...base,
        access: { ...access, playsUsed: 40 },
        mode: 'audius',
        rights: 'allowed',
      }),
    ).toEqual({ kind: 'blocked', reason: 'monthly_limit' });
  });
});

describe('tempo di ascolto per i premi (dal tempo del brano, non dai timer)', () => {
  it('invia 60 secondi dopo un minuto di riproduzione reale', () => {
    const clock = createListeningClock();
    const sent: number[] = [];
    for (let second = 0; second <= 61; second += 1) {
      const seconds = observeListening(clock, { position: second, nowMs: second * 1000 });
      if (seconds) sent.push(seconds);
    }
    expect(sent).toEqual([60]);
  });

  it('ignora seek in avanti, ritorni a zero e il tempo in pausa', () => {
    const clock = createListeningClock();
    observeListening(clock, { position: 10, nowMs: 0 });
    observeListening(clock, { position: 100, nowMs: 250 }); // seek forward
    observeListening(clock, { position: 0, nowMs: 500 }); // loop or new track
    expect(clock.pendingSeconds).toBe(0);
    observeListening(clock, { position: 1, nowMs: 1500 });
    expect(clock.pendingSeconds).toBe(1);
    restartListeningSample(clock); // paused for ten minutes
    observeListening(clock, { position: 1, nowMs: 600_000 });
    observeListening(clock, { position: 1.5, nowMs: 600_500 });
    expect(clock.pendingSeconds).toBeCloseTo(1.5);
  });

  it('conta anche quando gli eventi arrivano radi (pagina in background)', () => {
    const clock = createListeningClock();
    observeListening(clock, { position: 0, nowMs: 0 });
    expect(observeListening(clock, { position: 65, nowMs: 65_000 })).toBe(60);
    expect(clock.pendingSeconds).toBe(5);
  });

  it('porta il resto da un brano all’altro e rispetta l’intervallo minimo del server', () => {
    const clock = createListeningClock();
    observeListening(clock, { position: 0, nowMs: 0 });
    expect(observeListening(clock, { position: 60, nowMs: 60_000 })).toBe(60);
    // New track: the position restarts from zero, the remainder stays.
    observeListening(clock, { position: 0, nowMs: 61_000 });
    expect(observeListening(clock, { position: 59, nowMs: 120_000 })).toBe(0);
    expect(observeListening(clock, { position: 61, nowMs: 122_000 })).toBe(60);
    clock.pendingSeconds = 120;
    expect(observeListening(clock, { position: 61.2, nowMs: 130_000 })).toBe(0);
  });

  it('rimette in conto un invio fallito, entro il massimo accumulabile', () => {
    const clock = createListeningClock();
    restoreListening(clock, 60);
    expect(clock.pendingSeconds).toBe(60);
    restoreListening(clock, 10_000);
    expect(clock.pendingSeconds).toBe(LISTEN_MAX_BACKLOG_SECONDS);
  });
});

describe('sessione audio (Safari/iOS 16.4+)', () => {
  it('dichiara playback prima di suonare e torna ad auto alla chiusura', () => {
    const nav = { audioSession: { type: 'auto' } };
    expect(declarePlaybackSession(nav)).toBe(true);
    expect(nav.audioSession.type).toBe('playback');
    expect(releasePlaybackSession(nav)).toBe(true);
    expect(nav.audioSession.type).toBe('auto');
  });

  it('non fa nulla dove l’API non esiste (Android, iOS < 16.4) o rifiuta il valore', () => {
    expect(setAudioSessionType('playback', {})).toBe(false);
    const throwing = {
      audioSession: {
        get type() {
          return 'auto';
        },
        set type(_value: string) {
          throw new TypeError('unsupported');
        },
      },
    };
    expect(setAudioSessionType('playback', throwing)).toBe(false);
  });

  it('sblocca l’elemento audio con load() solo se non ha già una sorgente', () => {
    const load = vi.fn();
    expect(primeMediaElement({ getAttribute: () => null, load })).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(primeMediaElement({ getAttribute: () => '/api/x/stream', load })).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(primeMediaElement(null)).toBe(false);
  });
});
