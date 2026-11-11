// @polsia:user-owned — doppio elemento <audio>: regole pure di precaricamento, prontezza e ruoli.
import { describe, expect, it, vi } from 'vitest';
import {
  AudioDecks,
  type DeckElement,
  GAPLESS_DECKS_ENABLED,
  HAVE_METADATA,
  preloadDeck,
  preloadsOnSpare,
  releaseDeck,
  type SpareLoad,
  sameSpareLoad,
  spareReadyFor,
  wantsSparePreload,
} from '@/lib/music/audio-decks';

function fakeDeck(init: { src?: string; readyState?: number; error?: MediaError | null } = {}) {
  const attributes = new Map<string, string>();
  if (init.src) attributes.set('src', init.src);
  const deck = {
    readyState: init.readyState ?? 0,
    error: init.error ?? null,
    preload: 'none' as DeckElement['preload'],
    get src() {
      return attributes.get('src') ?? '';
    },
    set src(value: string) {
      attributes.set('src', value);
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    removeAttribute: vi.fn((name: string) => {
      attributes.delete(name);
    }),
    load: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
  };
  return deck;
}

const held: SpareLoad = {
  index: 1,
  qualifiedId: 'audius:track-b',
  src: '/api/music/audius/tracks/track-b/stream',
};

describe('interruttore e fonti', () => {
  it('è acceso e precarica solo brani on-demand Audius e album Solco', () => {
    expect(GAPLESS_DECKS_ENABLED).toBe(true);
    expect(preloadsOnSpare('audius')).toBe(true);
    expect(preloadsOnSpare('solco')).toBe(true);
    for (const mode of ['podcast', 'radio', 'jamendo', 'youtube', 'song', null, undefined]) {
      expect(preloadsOnSpare(mode)).toBe(false);
    }
  });

  it('precarica solo quando a fine brano partirebbe da solo, mai con "ripeti brano" o spento', () => {
    const switchNow = { kind: 'switch' } as const;
    const base = { enabled: true, mode: 'audius', repeatOne: false, decision: switchNow };
    expect(wantsSparePreload(base)).toBe(true);
    expect(wantsSparePreload({ ...base, mode: 'solco' })).toBe(true);
    expect(wantsSparePreload({ ...base, enabled: false })).toBe(false);
    expect(wantsSparePreload({ ...base, repeatOne: true })).toBe(false);
    expect(wantsSparePreload({ ...base, mode: 'podcast' })).toBe(false);
    expect(wantsSparePreload({ ...base, mode: 'youtube' })).toBe(false);
    // Rights not verified yet, Free limit or guest predicted, rights denied: no download at all.
    expect(wantsSparePreload({ ...base, decision: { kind: 'async' } })).toBe(false);
    expect(
      wantsSparePreload({ ...base, decision: { kind: 'blocked', reason: 'monthly_limit' } }),
    ).toBe(false);
    expect(
      wantsSparePreload({ ...base, decision: { kind: 'blocked', reason: 'login_required' } }),
    ).toBe(false);
    expect(wantsSparePreload({ ...base, decision: { kind: 'denied' } })).toBe(false);
  });
});

describe('riserva pronta', () => {
  it('confronta posizione, brano e stream', () => {
    expect(sameSpareLoad(held, { ...held })).toBe(true);
    expect(sameSpareLoad(null, held)).toBe(false);
    expect(sameSpareLoad(held, { ...held, index: 2 })).toBe(false);
    expect(sameSpareLoad(held, { ...held, qualifiedId: 'audius:track-c' })).toBe(false);
    expect(sameSpareLoad(held, { ...held, src: '/api/music/audius/tracks/track-c/stream' })).toBe(
      false,
    );
  });

  it('parte solo con esattamente quel brano e almeno i suoi metadati (preload metadata)', () => {
    expect(HAVE_METADATA).toBe(1);
    const ready = (readyState: number) =>
      spareReadyFor(fakeDeck({ src: held.src, readyState }), held, held);
    expect(ready(0)).toBe(false);
    // preload='metadata' may stop the spare here: its first bytes are cached, play() is quicker.
    expect(ready(1)).toBe(true);
    expect(ready(2)).toBe(true);
    expect(ready(3)).toBe(true);
    expect(ready(4)).toBe(true);

    const deck = fakeDeck({ src: held.src, readyState: 4 });
    expect(spareReadyFor(null, held, held)).toBe(false);
    expect(spareReadyFor(deck, null, held)).toBe(false);
    expect(spareReadyFor(deck, held, { ...held, qualifiedId: 'audius:track-c' })).toBe(false);
    expect(spareReadyFor(deck, held, { ...held, index: 0 })).toBe(false);
    const other = fakeDeck({ src: '/api/music/audius/tracks/track-c/stream', readyState: 4 });
    expect(spareReadyFor(other, held, held)).toBe(false);
    const failed = fakeDeck({ src: held.src, readyState: 4, error: {} as MediaError });
    expect(spareReadyFor(failed, held, held)).toBe(false);
  });
});

describe('operazioni sui deck', () => {
  it('il precaricamento usa preload metadata, mai auto, e non suona mai', () => {
    // With 'auto' a paused element asks for the counted continuation (byte 393216 on) by itself.
    const preloads: string[] = [];
    const deck = fakeDeck();
    Object.defineProperty(deck, 'preload', {
      get: () => preloads.at(-1) ?? 'none',
      set: (value: string) => {
        preloads.push(value);
      },
    });
    preloadDeck(deck, held.src);
    expect(deck.getAttribute('src')).toBe(held.src);
    expect(preloads).toEqual(['metadata']);
    expect(deck.load).toHaveBeenCalledTimes(1);
    expect(deck.play).not.toHaveBeenCalled();
  });

  it('liberare un deck lo ferma, toglie la sorgente e interrompe il download', () => {
    const deck = fakeDeck({ src: held.src, readyState: 4 });
    deck.preload = 'auto';
    releaseDeck(deck);
    expect(deck.pause).toHaveBeenCalledTimes(1);
    expect(deck.getAttribute('src')).toBeNull();
    expect(deck.preload).toBe('none');
    expect(deck.load).toHaveBeenCalledTimes(1);
    expect(() => releaseDeck(null)).not.toThrow();
  });

  it('scambia i ruoli: current è sempre il deck attivo', () => {
    const decks = new AudioDecks<ReturnType<typeof fakeDeck>>();
    const first = fakeDeck();
    const second = fakeDeck();
    expect(decks.current).toBeNull();
    decks.bindFirst(first);
    // Kill switch: only one element rendered, nothing to swap with.
    expect(decks.spareDeck).toBeNull();
    expect(decks.swap()).toBe(false);
    expect(decks.current).toBe(first);

    decks.bindSecond(second);
    expect(decks.current).toBe(first);
    expect(decks.spareDeck).toBe(second);
    expect(decks.isActive(first)).toBe(true);
    expect(decks.isActive(second)).toBe(false);
    expect(decks.isActive(null)).toBe(false);

    expect(decks.swap()).toBe(true);
    expect(decks.current).toBe(second);
    expect(decks.spareDeck).toBe(first);
    expect(decks.isActive(second)).toBe(true);
    expect(decks.swap()).toBe(true);
    expect(decks.current).toBe(first);
  });
});
