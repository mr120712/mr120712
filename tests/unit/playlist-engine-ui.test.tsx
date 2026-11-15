// @polsia:user-owned — pagina «Crea playlist»: tre scelte, bozza modificabile (Ascolta, Su/Giù,
// Sostituisci, Togli, Aggiungi altri simili), bozza nel sessionStorage (anche quando non c'è),
// salvataggio in un tocco con gli errori di campo sul modulo e ripiego senza AI.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  push: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: null,
    status: 'idle',
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
  trackStreamPath: (track: { qualifiedId: string }) => `/stream/${track.qualifiedId}`,
}));

import { PlaylistEngine } from '@/components/custom/music/playlist-engine';
import { DRAFT_STORAGE_KEY } from '@/lib/business/playlist-engine';
import type { DraftTrack, StoredDraft } from '@/lib/contracts/playlist-engine';

const song = (n: number): DraftTrack => ({
  source: 'song',
  sourceId: n.toString(16).padStart(32, 'a'),
  title: `Canzone ${n}`,
  creatorName: `Cantante ${n}`,
  artworkUrl: null,
  sourceUrl: null,
  artistUrl: null,
  durationSeconds: null,
});
const audius = (n: number): DraftTrack => ({
  source: 'audius',
  sourceId: `track-${n}`,
  title: `Audius ${n}`,
  creatorName: `Artista ${n}`,
  artworkUrl: `https://audius.co/art/${n}.jpg`,
  sourceUrl: `https://audius.co/artista/${n}`,
  artistUrl: 'https://audius.co/artista',
  durationSeconds: 200,
  token: `firma-${n}`,
});

const status = { signedIn: true, premium: false, ai: true, audius: true };
const firstSuggestion = {
  name: 'Atmosfera Relax',
  description: null,
  tracks: [audius(1), song(1), audius(2)],
  reserve: [song(2), audius(3)],
  ai: { status: 'not_requested', message: null },
  notice: null,
};

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<PlaylistEngine />));
  await flush();
  return container;
}

function byLabel(container: HTMLElement, label: string) {
  const element = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`manca ${label}`);
  return element;
}

function byText(container: HTMLElement, text: string) {
  const element = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text),
  );
  if (!element) throw new Error(`manca il pulsante ${text}`);
  return element;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function titles(container: HTMLElement) {
  return [...container.querySelectorAll('ol li strong')].map((node) => node.textContent);
}

function suggestCalls() {
  return mocks.apiFetch.mock.calls
    .filter(([path]) => path === '/api/music/playlist-engine/suggest')
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

async function createMoodDraft(container: HTMLElement) {
  await click(byText(container, 'Scegli l’atmosfera'));
  await click(byText(container, 'Relax'));
  await click(byText(container, 'Crea la bozza'));
}

beforeEach(() => {
  window.sessionStorage.clear();
  mocks.push.mockReset();
  mocks.playTrack.mockReset();
  mocks.togglePlayback.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.apiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/music/playlist-engine') return status;
    if (path === '/api/music/playlist-engine/suggest') return firstSuggestion;
    throw new Error(`inatteso ${path}`);
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Crea playlist', () => {
  it('mostra tre scelte grandi con etichette semplici', async () => {
    const container = await mount();
    const choices = [...container.querySelectorAll('fieldset button[aria-pressed]')].map(
      (button) => button.querySelector('strong')?.textContent,
    );
    expect(choices).toEqual([
      'Descrivila con parole tue',
      'Parti da un brano o da un artista',
      'Scegli l’atmosfera',
    ]);
  });

  it('atmosfera senza AI → bozza modificabile con Su/Giù, Togli, Sostituisci e Aggiungi altri', async () => {
    const container = await mount();
    await createMoodDraft(container);
    expect(suggestCalls()[0]).toEqual({
      mode: 'mood',
      mood: 'relax',
      genre: null,
      useAi: false,
      count: 20,
      exclude: [],
    });
    expect(titles(container)).toEqual(['Audius 1', 'Canzone 1', 'Audius 2']);
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'Atmosfera Relax',
    );
    expect(container.textContent).toContain('1 li cerco su YouTube quando li ascolti');

    await click(byLabel(container, 'Sposta giù «Audius 1»'));
    expect(titles(container)).toEqual(['Canzone 1', 'Audius 1', 'Audius 2']);
    expect(container.querySelector('output')?.textContent).toContain('posizione 2 di 3');
    expect(byLabel(container, 'Sposta su «Canzone 1»').disabled).toBe(true);

    await click(byLabel(container, 'Togli «Audius 2»'));
    expect(titles(container)).toEqual(['Canzone 1', 'Audius 1']);

    await click(byLabel(container, 'Sostituisci «Canzone 1»'));
    expect(titles(container)).toEqual(['Canzone 2', 'Audius 1']);

    // Le scorte hanno solo Audius 3: il resto arriva da una nuova proposta senza doppioni.
    mocks.apiFetch.mockImplementationOnce(async () => ({
      ...firstSuggestion,
      tracks: [song(5), song(6), song(7), song(8)],
      reserve: [],
    }));
    await click(byText(container, 'Aggiungi altri simili'));
    expect(titles(container)).toEqual([
      'Canzone 2',
      'Audius 1',
      'Audius 3',
      'Canzone 5',
      'Canzone 6',
      'Canzone 7',
      'Canzone 8',
    ]);
    const more = suggestCalls()[1];
    expect(more).toMatchObject({ mode: 'mood', mood: 'relax', count: 6 });
    expect(more.exclude.map((track: { sourceId: string }) => track.sourceId)).toEqual([
      song(2).sourceId,
      'track-1',
      'track-3',
    ]);

    // La bozza è nel sessionStorage, nell'ordine attuale.
    const stored = JSON.parse(window.sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? '{}');
    expect(stored.tracks.map((track: DraftTrack) => track.title)).toEqual(titles(container));
  });

  it('Ascolta usa il player della Libreria: Audius subito, i "song" solo quando suonano', async () => {
    const container = await mount();
    await createMoodDraft(container);
    await click(byLabel(container, 'Ascolta «Canzone 1»'));
    const [track, path, queue] = mocks.playTrack.mock.calls[0] ?? [];
    expect(track).toMatchObject({ qualifiedId: `song:${song(1).sourceId}`, playbackMode: 'song' });
    expect(path).toBe(`/stream/song:${song(1).sourceId}`);
    expect(queue).toHaveLength(3);
    await click(byLabel(container, 'Ascolta «Audius 1»'));
    expect(mocks.playTrack.mock.calls[1]?.[0]).toMatchObject({ playbackMode: 'audius' });
    // Nessuna ricerca YouTube in blocco dalla pagina.
    expect(mocks.apiFetch.mock.calls.some(([path]) => String(path).includes('resolve-song'))).toBe(
      false,
    );
  });

  it('Salva nella Libreria in un tocco e porta alla playlist', async () => {
    const container = await mount();
    await createMoodDraft(container);
    mocks.apiFetch.mockImplementationOnce(async () => ({
      collectionId: 'c9',
      name: 'Atmosfera Relax',
      saved: 3,
      skipped: 0,
    }));
    await click(byText(container, 'Salva nella Libreria'));
    const call = mocks.apiFetch.mock.calls.find(
      ([path]) => path === '/api/music/playlist-engine/save',
    );
    expect(JSON.parse((call?.[1] as { body: string }).body)).toEqual({
      name: 'Atmosfera Relax',
      description: null,
      tracks: firstSuggestion.tracks,
    });
    expect(mocks.push).toHaveBeenCalledWith('/library?playlist=c9');
    expect(mocks.toastSuccess).toHaveBeenLastCalledWith(
      '«Atmosfera Relax» è nella tua Libreria con 3 brani.',
    );
    expect(window.sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('un errore di campo dal server torna sotto il nome', async () => {
    const container = await mount();
    await createMoodDraft(container);
    mocks.apiFetch.mockImplementationOnce(async () => {
      throw new Error('apiFetch failed (400)', {
        cause: { errors: { name: 'Il nome «Preferiti» è riservato: scegline un altro.' } },
      });
    });
    await click(byText(container, 'Salva nella Libreria'));
    const input = container.querySelector<HTMLInputElement>('input[name="name"]');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Il nome «Preferiti» è riservato');
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('descrizione senza AI disponibile: messaggio chiaro e strada senza AI', async () => {
    const container = await mount();
    await click(byText(container, 'Descrivila con parole tue'));
    expect(container.textContent).toContain('Le proposte con l’AI sono incluse in Premium.');
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('manca la descrizione');
    await act(async () => setValue(textarea, 'canzoni allegre per una cena'));
    mocks.apiFetch.mockImplementationOnce(async () => {
      throw new Error('apiFetch failed (402)', {
        cause: {
          error: 'premium_required',
          message: 'Le proposte con l’AI sono incluse in Premium.',
        },
      });
    });
    await click(byText(container, 'Crea la bozza'));
    expect(suggestCalls().at(-1)).toMatchObject({
      mode: 'describe',
      prompt: 'canzoni allegre per una cena',
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('incluse in Premium');
    await click(byText(alert as HTMLElement, 'Prova «Scegli l’atmosfera»'));
    expect(container.querySelector('h2')?.textContent).toBe('Scegli l’atmosfera');
    // Il pulsante di ripiego sparisce: il focus va al titolo del pannello, non al body.
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.textContent).toBe('Scegli l’atmosfera');
  });

  it('il collegamento «scegliere l’atmosfera» dell’avviso porta il focus al nuovo pannello', async () => {
    const container = await mount();
    await click(byText(container, 'Descrivila con parole tue'));
    await click(byText(container, 'scegliere l’atmosfera'));
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.textContent).toBe('Scegli l’atmosfera');
    // Il primo Tab porta al primo mood, non al piè di pagina.
    const chips = container.querySelectorAll('fieldset button[aria-pressed]');
    expect([...chips].some((chip) => chip.textContent?.includes('Relax'))).toBe(true);
  });

  it('senza AI, dopo «Cerca su Audius» parte dal primo risultato e spiega perché', async () => {
    const container = await mount();
    await click(byText(container, 'Parti da un brano o da un artista'));
    const input = container.querySelector<HTMLInputElement>('input[placeholder]');
    if (!input) throw new Error('manca il campo');
    expect(input.placeholder).toBe('es. il nome di un artista o di un brano');
    expect(container.textContent).toContain('Senza l’AI parto solo da brani che sono su Audius');
    await act(async () => setValue(input, 'Vasco Rossi'));
    mocks.apiFetch.mockImplementationOnce(async () => ({
      tracks: [
        {
          id: 'r1',
          title: 'Albachiara (cover)',
          artistName: 'Raf Marchesini',
          genre: 'Pop',
          mood: 'Upbeat',
          playbackEligible: true,
        },
      ],
    }));
    await click(byText(container, 'Cerca su Audius'));
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
      (radio) => radio.name.endsWith('-seed-choice'),
    );
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
    await click(byText(container, 'Crea la bozza'));
    expect(suggestCalls().at(-1)).toMatchObject({
      mode: 'seed',
      seed: {
        artist: 'Raf Marchesini',
        title: 'Albachiara (cover)',
        audius: { trackId: 'r1', genre: 'Pop', mood: 'Upbeat' },
      },
      useAi: false,
    });
  });

  it('con l’AI la ricerca su Audius lascia scelto il testo scritto', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/music/playlist-engine') return { ...status, premium: true };
      if (path.startsWith('/api/music/search')) {
        return {
          tracks: [
            {
              id: 'r1',
              title: 'X',
              artistName: 'Y',
              genre: null,
              mood: null,
              playbackEligible: true,
            },
          ],
        };
      }
      return firstSuggestion;
    });
    const container = await mount();
    await click(byText(container, 'Parti da un brano o da un artista'));
    const input = container.querySelector<HTMLInputElement>('input[placeholder]');
    if (!input) throw new Error('manca il campo');
    expect(input.placeholder).toBe('es. Lucio Dalla - Caruso');
    await act(async () => setValue(input, 'Lucio Dalla - Caruso'));
    await click(byText(container, 'Cerca su Audius'));
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
      (radio) => radio.name.endsWith('-seed-choice'),
    );
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
  });

  it('«Sostituisci» e «Togli» hanno un’etichetta visibile; le icone hanno un suggerimento', async () => {
    const container = await mount();
    await createMoodDraft(container);
    expect(byLabel(container, 'Sostituisci «Audius 1»').textContent).toBe('Sostituisci');
    expect(byLabel(container, 'Togli «Audius 1»').textContent).toBe('Togli');
    expect(byLabel(container, 'Sposta su «Audius 1»').title).toBe('Sposta su');
    expect(byLabel(container, 'Sposta giù «Audius 1»').title).toBe('Sposta giù');
    expect(byLabel(container, 'Ascolta «Audius 1»').title).toBe('Ascolta');
  });

  it('«Ricomincia» chiede conferma prima di buttare la bozza', async () => {
    const container = await mount();
    await createMoodDraft(container);
    const restart = byText(container, 'Ricomincia');
    await click(restart);
    let dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Vuoi buttare questa bozza?');
    expect(dialog?.textContent).toContain('I 3 brani');
    // Annulla: la bozza resta, anche nel sessionStorage.
    await click(byText(dialog as HTMLElement, 'Tienila'));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(titles(container)).toEqual(['Audius 1', 'Canzone 1', 'Audius 2']);
    expect(window.sessionStorage.getItem(DRAFT_STORAGE_KEY)).not.toBeNull();

    await click(byText(container, 'Ricomincia'));
    dialog = document.querySelector('[role="alertdialog"]');
    await click(byText(dialog as HTMLElement, 'Butta la bozza'));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(titles(container)).toEqual([]);
    expect(window.sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    expect(document.activeElement?.textContent).toContain('Scegli l’atmosfera');
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true');
  });

  it('una nuova bozza non ripete l’annuncio della bozza precedente', async () => {
    const container = await mount();
    await createMoodDraft(container);
    await click(byLabel(container, 'Togli «Canzone 1»'));
    expect(container.querySelector('output')?.textContent).toBe('«Canzone 1» tolto dalla bozza.');
    await click(byText(container, 'Ricomincia'));
    const dialog = document.querySelector('[role="alertdialog"]');
    await click(byText(dialog as HTMLElement, 'Butta la bozza'));
    expect(container.querySelector('output')?.textContent).toBe('');
    mocks.apiFetch.mockImplementationOnce(async () => ({ ...firstSuggestion, tracks: [song(9)] }));
    await click(byText(container, 'Crea la bozza'));
    expect(titles(container)).toEqual(['Canzone 9']);
    expect(container.querySelector('output')?.textContent ?? '').not.toContain('tolto');
  });

  it('un ricaricamento ritrova la bozza', async () => {
    const draft: StoredDraft = {
      version: 1,
      origin: { mode: 'mood', mood: 'notte', genre: null, useAi: false },
      name: 'La mia notte',
      description: 'Per dormire',
      tracks: [song(3), audius(4)],
      reserve: [],
    };
    window.sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    const container = await mount();
    expect(titles(container)).toEqual(['Canzone 3', 'Audius 4']);
    expect(container.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      'La mia notte',
    );
  });

  it('senza sessionStorage (bloccato o pieno) la pagina funziona lo stesso', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const container = await mount();
    await createMoodDraft(container);
    expect(titles(container)).toEqual(['Audius 1', 'Canzone 1', 'Audius 2']);
    await click(byLabel(container, 'Togli «Canzone 1»'));
    expect(titles(container)).toEqual(['Audius 1', 'Audius 2']);
  });
});
