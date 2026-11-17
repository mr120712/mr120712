// @polsia:user-owned — pagina /admin/diritti-testi, «Rifinisci con Solco AI» nell'editor della bozza:
// il pulsante manda a …/transcribe/refine il testo dell'editor (con le correzioni fatte a mano), la
// lingua riconosciuta nella bozza e la durata; l'editor si chiude, la scheda mostra «Rifinitura in
// corso…» con «Annulla», poi l'editor si riapre con la bozza rifinita, il badge, la copertura, le righe
// senza riscontro e la nota; «Ripristina la bozza di prima» rimette testo e bozza di prima. Un errore
// del server (502 generico o 400 sul campo `lrc`) lascia la bozza com'era e lo dice nella scheda;
// «Annulla» interrompe la richiesta.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/diritti-testi' }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: null }) }));
vi.mock('sonner', () => ({
  toast: Object.assign(mocks.toast, { success: mocks.success, error: mocks.error }),
}));

import { FeaturedRightsDashboard } from '@/components/custom/admin/featured-rights-dashboard';
import type {
  AdminFeaturedRights,
  FeaturedRightsTrack,
} from '@/lib/contracts/admin-featured-rights';
import {
  type RefineLyricsResponse,
  TRANSCRIPTION_REFINED_HINT,
  type TranscribeResponse,
} from '@/lib/contracts/lyrics-transcription';

const NOW = '2026-11-16T15:30:00.000Z';
const REPORT = '/api/admin/featured-rights';
const TRANSCRIBE = '/api/admin/featured-rights/transcribe';
const REFINE = '/api/admin/featured-rights/transcribe/refine';
const SONG = 'Cantautori/Autrice - Canzone.mp3';

function row(pathname: string, extra: Partial<FeaturedRightsTrack> = {}): FeaturedRightsTrack {
  const name = pathname.slice(pathname.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const [artist, title] = name.split(' - ');
  return {
    pathname,
    folder: pathname.slice(0, pathname.lastIndexOf('/')),
    section: 'Sezione',
    title: title ?? name,
    artist: artist ?? null,
    declared: false,
    licenza: null,
    titolare: null,
    testo: false,
    testoOffBy: null,
    sidecars: { lrc: false, txt: false },
    lyrics: { status: 'not_checked' },
    ...extra,
  };
}

const TRACKS: FeaturedRightsTrack[] = [
  row(SONG, {
    declared: true,
    licenza: 'propria',
    titolare: 'Autrice',
    testo: true,
    lyrics: { status: 'none' },
    transcription: 'ready',
  }),
  row('Rock/Band - Inno.mp3', { declared: true, licenza: 'propria', titolare: 'Band' }),
];

function report(): AdminFeaturedRights {
  return {
    generatedAt: NOW,
    store: { status: 'ok', listedAt: NOW, reason: null },
    manifest: {
      status: 'valid',
      reasons: [],
      location: null,
      counts: { entries: 2, valid: 2, invalid: 0, ignored: 0 },
      problems: [],
    },
    summary: {
      totalTracks: 2,
      declared: 2,
      declaredWithLyrics: 1,
      lyricsFound: 0,
      lyricsMissing: 1,
      lyricsErrors: 0,
      lyricsSkipped: 0,
      lyricsNotShown: 0,
      manifestProblems: 0,
    },
    tracks: TRACKS,
    tracksTruncated: false,
    transcriptionAvailable: true,
  };
}

/** La bozza di Solco AI, parola per parola, con due refusi («celo», «me»). */
const DRAFT: TranscribeResponse = {
  draft:
    '[00:12.00] <00:12.00>sotto <00:12.40>il <00:12.80>celo <00:13.20>di <00:13.60>roma\n[00:14.00] <00:14.00>canto <00:14.40>per <00:14.80>me <00:15.20>stasera',
  lineCount: 2,
  language: 'italian',
  durationSeconds: 184.4,
  droppedSegments: 0,
  uncertainLines: [1],
  wordTimed: true,
  fromCache: false,
  cachedAt: '2026-11-16T15:31:00.000Z',
  engine: 'Solco AI (Groq · whisper-large-v3)',
};

/** La bozza corretta a mano nell'editor prima di rifinire («me» → «te»). */
const EDITED = DRAFT.draft.replace('<00:14.80>me', '<00:14.80>te');

const REFINED: RefineLyricsResponse = {
  draft:
    '[00:12.00] <00:12.00>Sotto <00:12.40>il <00:12.80>cielo <00:13.20>di <00:13.60>Roma,\n[00:14.00] <00:14.00>canto <00:14.40>per <00:14.80>te <00:15.20>stasera',
  lineCount: 2,
  wordTimed: true,
  refined: {
    coverage: 0.889,
    matchedWords: 8,
    totalWords: 9,
    unmatchedLines: [2],
    linesBefore: 2,
    linesAfter: 2,
  },
};

type FetchInit = {
  method?: string;
  body?: string;
  signal?: AbortSignal;
  schema?: { parse: (value: unknown) => unknown };
};
type Handler = (init: FetchInit) => Promise<unknown>;

let handlers: Record<string, Handler> = {};

function route(path: string, init: FetchInit = {}) {
  const handler = handlers[path];
  if (!handler) throw new Error(`Percorso inatteso: ${path}`);
  return handler(init);
}

function respondWith(value: unknown): Handler {
  return async (init) => (init.schema ? init.schema.parse(value) : value);
}

function apiError(path: string, status: number, body: Record<string, unknown>) {
  return new Error(`apiFetch ${path} failed (${status})`, { cause: body });
}

/** Una richiesta che resta in attesa: si risolve a mano o si interrompe col segnale. */
function pending() {
  let resolve: (value: unknown) => void = () => undefined;
  const calls: FetchInit[] = [];
  const handler: Handler = (init) => {
    calls.push(init);
    return new Promise((done, fail) => {
      resolve = (value) => done(init.schema ? init.schema.parse(value) : value);
      init.signal?.addEventListener('abort', () =>
        fail(new DOMException('The operation was aborted.', 'AbortError')),
      );
    });
  };
  return { handler, calls, resolve: (value: unknown) => resolve(value) };
}

const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => root.render(<FeaturedRightsDashboard />));
  await flush();
  return container;
}

function article(container: HTMLElement, title: string) {
  const heading = [...container.querySelectorAll('article h3')].find(
    (element) => element.textContent === title,
  );
  const element = heading?.closest('article');
  if (!element) throw new Error(`Brano "${title}" non trovato.`);
  return element as HTMLElement;
}

function button(scope: ParentNode, text: string) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    element.textContent?.trim().startsWith(text),
  );
  if (!found) throw new Error(`Pulsante "${text}" non trovato.`);
  return found;
}

function maybeButton(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    element.textContent?.trim().startsWith(text),
  );
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await flush();
}

async function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

function dialog() {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

function editorField() {
  return dialog()?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
}

function requestBody(init: FetchInit | undefined) {
  return JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
}

function callsTo(path: string) {
  return mocks.apiFetch.mock.calls.filter(([called]) => called === path);
}

/** Monta la pagina, trascrive il brano ammesso e torna con la scheda e l'editor aperto. */
async function openEditor() {
  const container = await mount();
  const card = article(container, 'Autrice — Canzone');
  await click(button(card, 'Trascrivi con Solco AI'));
  const editor = dialog();
  if (!editor) throw new Error('Editor non aperto.');
  return { container, card, editor };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.toast.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
  mocks.writeText.mockReset();
  handlers = { [REPORT]: respondWith(report()), [TRANSCRIBE]: respondWith(DRAFT) };
  mocks.apiFetch.mockImplementation((path: string, init?: FetchInit) => route(path, init));
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mocks.writeText },
    configurable: true,
  });
});

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.innerHTML = '';
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.unstubAllGlobals();
});

describe('«Rifinisci con Solco AI»', () => {
  it('manda il testo dell’editor con lingua e durata, mostra l’avanzamento e riapre l’editor rifinito; «Ripristina» torna indietro', async () => {
    const { card, editor } = await openEditor();
    expect(card.textContent).toContain('il testo della bozza va al modello di Solco AI');
    const field = editorField();
    expect(field?.value).toBe(DRAFT.draft);
    await typeInto(field as HTMLTextAreaElement, EDITED);

    const refine = pending();
    handlers[REFINE] = refine.handler;
    await click(button(editor, 'Rifinisci con Solco AI'));

    // L'editor si chiude, la scheda mostra l'avanzamento e «Annulla»; la richiesta porta il testo
    // dell'editor (con la correzione a mano), la lingua riconosciuta e la durata della bozza.
    expect(dialog()).toBeNull();
    expect(card.textContent).toContain('Rifinitura in corso… può richiedere fino a un minuto');
    expect(maybeButton(card, 'Annulla')).toBeDefined();
    expect(card.getAttribute('aria-busy') ?? card.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(refine.calls).toHaveLength(1);
    expect(refine.calls[0]?.method).toBe('POST');
    expect(requestBody(refine.calls[0])).toEqual({
      pathname: SONG,
      lrc: EDITED,
      language: 'it',
      durationSeconds: 184.4,
    });
    expect(refine.calls[0]?.signal).toBeInstanceOf(AbortSignal);

    refine.resolve(REFINED);
    await flush();
    const reopened = dialog();
    expect(reopened).not.toBeNull();
    expect(editorField()?.value).toBe(REFINED.draft);
    expect(reopened?.textContent).toContain(
      'Bozza rifinita da Solco AI: controlla parole e tempi prima di salvare.',
    );
    expect(reopened?.textContent).toContain('Rifinita da Solco AI');
    expect(reopened?.textContent).toContain(
      'Rifinita da Solco AI: 89% delle parole (8 su 9) ha un tempo preso dalla bozza di prima',
    );
    expect(reopened?.textContent).toContain('Righe: da 2 a 2.');
    expect(reopened?.textContent).toContain('Righe senza riscontro nella bozza di prima: 2');
    expect(reopened?.textContent).toContain(TRANSCRIPTION_REFINED_HINT);
    // Il motore e l'origine restano quelli della trascrizione; le righe incerte di prima non valgono più.
    expect(reopened?.textContent).toContain('Motore: Solco AI (Groq · whisper-large-v3)');
    expect(reopened?.textContent).toContain('Nuova trascrizione · salvata in modo cifrato');
    expect(reopened?.textContent).not.toContain('Righe da controllare');
    expect(mocks.success).toHaveBeenCalledWith(
      'Bozza rifinita: 2 righe, 89% delle parole con un tempo preso dalla bozza di prima.',
    );
    expect(callsTo(TRANSCRIBE)).toHaveLength(1);

    // «Ripristina la bozza di prima»: il testo torna quello corretto a mano, senza badge né nota.
    await click(button(reopened as HTMLElement, 'Ripristina la bozza di prima'));
    expect(editorField()?.value).toBe(EDITED);
    expect(dialog()?.textContent).not.toContain('Rifinita da Solco AI');
    expect(maybeButton(dialog() as HTMLElement, 'Ripristina la bozza di prima')).toBeUndefined();
    expect(dialog()?.textContent).toContain('Righe da controllare: 1');
    expect(mocks.toast).toHaveBeenCalledWith('Bozza di prima ripristinata.');
    expect(callsTo(REFINE)).toHaveLength(1);
  });

  it('un rifiuto del server lascia la bozza com’era: errore nella scheda, avviso, «Riapri la bozza»', async () => {
    const { card, editor } = await openEditor();
    const message =
      'Solco AI ha cambiato troppo il testo (solo il 40% delle parole corrisponde alla bozza): la bozza è rimasta com’era. Riprova o correggi a mano.';
    handlers[REFINE] = async () => {
      throw apiError(REFINE, 502, { error: 'refine_rejected', message });
    };
    await click(button(editor, 'Rifinisci con Solco AI'));
    expect(dialog()).toBeNull();
    expect(card.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(mocks.error).toHaveBeenCalledWith(message);
    // L'unico avviso di riuscita è quello della trascrizione: nessuna «Bozza rifinita».
    expect(mocks.success.mock.calls.flat().join(' ')).not.toContain('rifinita');

    await click(button(card, 'Riapri la bozza'));
    expect(editorField()?.value).toBe(DRAFT.draft);
    expect(dialog()?.textContent).not.toContain('Rifinita da Solco AI');
    expect(maybeButton(dialog() as HTMLElement, 'Ripristina la bozza di prima')).toBeUndefined();
  });

  it('il 400 del server sul campo `lrc` arriva come messaggio; «Annulla» interrompe la richiesta', async () => {
    const { card, editor } = await openEditor();
    const fieldMessage = 'La bozza non ha i tempi: Solco AI rifinisce solo bozze sincronizzate.';
    handlers[REFINE] = async () => {
      throw apiError(REFINE, 400, { error: 'refine_invalid', errors: { lrc: fieldMessage } });
    };
    await click(button(editor, 'Rifinisci con Solco AI'));
    expect(card.querySelector('[role="alert"]')?.textContent).toBe(fieldMessage);
    expect(mocks.error).toHaveBeenCalledWith(fieldMessage);

    await click(button(card, 'Riapri la bozza'));
    const refine = pending();
    handlers[REFINE] = refine.handler;
    await click(button(dialog() as HTMLElement, 'Rifinisci con Solco AI'));
    expect(card.textContent).toContain('Rifinitura in corso…');
    await click(button(card, 'Annulla'));
    expect(refine.calls[0]?.signal?.aborted).toBe(true);
    expect(card.textContent).not.toContain('Rifinitura in corso…');
    expect(card.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith('Rifinitura annullata: la bozza è rimasta com’era.');
    expect(maybeButton(card, 'Riapri la bozza')).toBeDefined();
    expect(callsTo(REFINE)).toHaveLength(2);
  });

  it('senza una lingua riconosciuta fra quelle della pagina la richiesta non porta la lingua', async () => {
    handlers[TRANSCRIBE] = respondWith({ ...DRAFT, language: 'klingon', durationSeconds: null });
    const { editor } = await openEditor();
    const refine = pending();
    handlers[REFINE] = refine.handler;
    await click(button(editor, 'Rifinisci con Solco AI'));
    expect(requestBody(refine.calls[0])).toEqual({ pathname: SONG, lrc: DRAFT.draft });
    refine.resolve(REFINED);
    await flush();
    expect(editorField()?.value).toBe(REFINED.draft);
  });
});
