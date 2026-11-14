// @polsia:user-owned — flashcard: «Sfida un amico» solo sulle carte dei tuoi ascolti (quelle con un
// brano). Il link è il quiz /quiz (con l'id Audius per un brano Audius) e il testo condiviso porta
// la domanda, mai la risposta. /flashcards?mazzo=ascolti («Crea la tua sfida» del quiz) apre quel
// mazzo; i video YouTube senza «Artista - Titolo» non diventano carte (il canale non è l'artista).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  library: {
    signedIn: true,
    loading: false,
    library: { stations: [], podcasts: [], folders: [], history: [] as unknown[], hidden: [] },
    refresh: async () => undefined,
    mutate: async () => false,
    isHidden: () => false,
    isStationSaved: () => false,
    isPodcastFollowed: () => false,
  },
}));

vi.mock('@/components/custom/music/library-context', () => ({ useLibrary: () => mocks.library }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FlashcardsView } from '@/components/custom/music/flashcards-view';
import { historyDeck } from '@/lib/business/flashcards';
import { searchParamsRecord } from '@/lib/business/social-share';
import { QUIZ_CREATE_PATH, songQuizFromParams } from '@/lib/business/song-quiz';
import type { HistoryEntry } from '@/lib/contracts/library';

const entry = (overrides: Partial<HistoryEntry>): HistoryEntry => ({
  qualifiedId: 'jamendo:1',
  title: 'Strada Nuova',
  artistName: 'Band Finta',
  artworkUrl: null,
  sourceLabel: 'Jamendo',
  sourceUrl: null,
  albumId: null,
  durationSeconds: 180,
  playbackMode: 'jamendo',
  playCount: 1,
  lastPlayedAt: '2026-11-11T10:00:00.000Z',
  ...overrides,
});

const HISTORY: HistoryEntry[] = [
  entry({
    qualifiedId: 'audius:J7Xb000',
    title: 'Luci basse',
    artistName: 'Artista Audius',
    playbackMode: 'audius',
    sourceLabel: 'Audius',
  }),
  entry({}),
  entry({
    qualifiedId: 'youtube:abcdefghijk',
    title: 'Gruppo Inventato - Luce del Mattino (Official Video)',
    artistName: 'GruppoInventatoVEVO',
    playbackMode: 'youtube',
  }),
];

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<FlashcardsView />));
  return container;
}

async function openDeck(container: HTMLElement, label: string) {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent === label,
  );
  expect(tab).toBeDefined();
  await act(async () => tab?.click());
}

function challengeButton() {
  return document.querySelector<HTMLButtonElement>(
    'button[aria-label="Sfida un amico con questa carta"]',
  );
}

async function openChallengeMenu() {
  const trigger = challengeButton();
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.focus();
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  return [...document.querySelectorAll<HTMLAnchorElement>('[role="menu"] a')];
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.library.library.history = HISTORY;
  window.localStorage.clear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

describe('historyDeck: il brano della carta', () => {
  it('titolo, artista e id Audius (solo per i brani Audius)', () => {
    expect(historyDeck(HISTORY).map((card) => card.song)).toEqual([
      { title: 'Luci basse', artist: 'Artista Audius', audiusId: 'J7Xb000' },
      { title: 'Strada Nuova', artist: 'Band Finta', audiusId: null },
      { title: 'Luce del Mattino', artist: 'Gruppo Inventato', audiusId: null },
    ]);
  });

  it('video YouTube senza «Artista - Titolo»: nessuna carta (il canale non è l’artista)', () => {
    const videos = [
      entry({
        qualifiedId: 'youtube:aaaaaaaaaaa',
        title: 'Laura Pausini: La solitudine (Official Video)',
        artistName: 'Warner Music Italy',
        playbackMode: 'youtube',
      }),
      entry({
        qualifiedId: 'youtube:bbbbbbbbbbb',
        title: 'Hello lyrics',
        artistName: '7clouds',
        playbackMode: 'youtube',
      }),
      // Separatori con una parte vuota: prima passava il controllo e la risposta era il canale.
      entry({
        qualifiedId: 'youtube:ccccccccccc',
        title: 'Hello -  - Live',
        artistName: 'Canale',
        playbackMode: 'youtube',
      }),
    ];
    expect(historyDeck(videos)).toEqual([]);
  });
});

describe('flashcard: «Sfida un amico»', () => {
  it('carta dei tuoi ascolti: quiz con l’id Audius, testo senza la risposta', async () => {
    const container = await mount();
    await openDeck(container, 'I tuoi ascolti');
    expect(container.textContent).toContain('Chi interpreta “Luci basse”?');
    const links = await openChallengeMenu();
    const telegram = links.find((anchor) => anchor.href.startsWith('https://t.me/share/url'));
    const params = new URL(telegram?.href ?? 'https://invalid.example').searchParams;
    const shared = new URL(params.get('url') ?? 'https://invalid.example');
    expect(shared.pathname).toBe('/quiz');
    expect(songQuizFromParams(searchParamsRecord(shared.searchParams))).toEqual({
      title: 'Luci basse',
      artist: 'Artista Audius',
      audiusId: 'J7Xb000',
    });
    expect(params.get('text')).toBe('Sai chi interpreta «Luci basse»? Gira la carta su Solco.');
    // In nessun link del menu la risposta è leggibile.
    for (const anchor of links) {
      expect(decodeURIComponent(anchor.href)).not.toContain('Artista Audius');
    }
  });

  it('«Artista - Titolo» in un brano Audius: la domanda condivisa non porta l’artista', async () => {
    mocks.library.library.history = [
      entry({
        qualifiedId: 'audius:Ab1',
        title: 'Skrillex - Bangarang (feat. Sirah)',
        artistName: 'Skrillex',
        playbackMode: 'audius',
        sourceLabel: 'Audius',
      }),
      ...HISTORY,
    ];
    const container = await mount();
    await openDeck(container, 'I tuoi ascolti');
    const links = await openChallengeMenu();
    const telegram = links.find((anchor) => anchor.href.startsWith('https://t.me/share/url'));
    const params = new URL(telegram?.href ?? 'https://invalid.example').searchParams;
    expect(params.get('text')).toBe(
      'Sai chi interpreta «Bangarang (feat. Sirah)»? Gira la carta su Solco.',
    );
    for (const anchor of links) {
      expect(decodeURIComponent(anchor.href).toLowerCase()).not.toContain('skrillex');
    }
  });

  it('?mazzo=ascolti («Crea la tua sfida») apre il mazzo dei tuoi ascolti', async () => {
    window.history.replaceState(null, '', QUIZ_CREATE_PATH);
    const container = await mount();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'I tuoi ascolti',
    );
    expect(challengeButton()).not.toBeNull();
  });

  it('un ?mazzo= sconosciuto lascia i generi', async () => {
    window.history.replaceState(null, '', '/flashcards?mazzo=boh');
    const container = await mount();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Generi',
    );
  });

  it('il mazzo dei generi e quello di teoria non hanno «Sfida un amico»', async () => {
    const container = await mount();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Generi',
    );
    expect(container.textContent).toContain('Quale genere è questo?');
    expect(challengeButton()).toBeNull();
    await openDeck(container, 'Teoria e storia');
    expect(challengeButton()).toBeNull();
    await openDeck(container, 'I tuoi ascolti');
    expect(challengeButton()).not.toBeNull();
  });
});
