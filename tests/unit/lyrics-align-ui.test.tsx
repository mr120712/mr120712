// @polsia:user-owned — pagina /admin/diritti-testi, «Ho il testo: allinea» (Solco AI): il pulsante
// compare SOLO sui brani dichiarati con "testo": true e apre il campo del testo ufficiale con la
// nota; testo vuoto → errore in linea senza richiesta; richiesta a …/transcribe/align con testo e
// lingua, avanzamento «Allineamento in corso…» con «Annulla», editor con il testo allineato, la
// descrizione e le note (copertura, righe senza riscontro, suggerimento), avviso di riuscita; il 400
// del server sul campo `lyrics` resta sotto il testo nel blocco aperto; una bozza modificata chiede
// conferma prima di essere sostituita; «Copia il testo» nell'editor copia il testo negli appunti.
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
  TRANSCRIPTION_ALIGNED_HINT,
  type TranscribeResponse,
  TranscribeResponseSchema,
} from '@/lib/contracts/lyrics-transcription';

const NOW = '2026-11-16T15:30:00.000Z';
const REPORT = '/api/admin/featured-rights';
const TRANSCRIBE = '/api/admin/featured-rights/transcribe';
const ALIGN = '/api/admin/featured-rights/transcribe/align';
const SONG = 'Cantautori/Autrice - Canzone.mp3';
const OFFICIAL = 'Sotto il cielo di Roma\ncanto per te stasera';

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
  row('Pop/Ignoto - Copiato.mp3', { sidecars: { lrc: true, txt: false } }),
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
      totalTracks: 3,
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

const DRAFT: TranscribeResponse = {
  draft: '[00:12.30] Prima strofa\n[00:20.00] Ritornello',
  lineCount: 2,
  language: 'italian',
  durationSeconds: 184.4,
  droppedSegments: 0,
  uncertainLines: [2],
  wordTimed: false,
  fromCache: false,
  cachedAt: '2026-11-16T15:31:00.000Z',
};

const ALIGNED: TranscribeResponse = {
  draft:
    '[00:12.00] <00:12.00>Sotto <00:12.40>il <00:12.80>cielo <00:13.20>di <00:13.60>Roma\n[00:14.00] <00:14.00>canto <00:14.40>per <00:14.80>te <00:15.20>stasera',
  lineCount: 2,
  language: 'italian',
  durationSeconds: 184.4,
  droppedSegments: 1,
  uncertainLines: [],
  wordTimed: true,
  fromCache: true,
  cachedAt: '2026-11-16T15:00:00.000Z',
  aligned: { coverage: 0.929, matchedWords: 13, totalWords: 14, unmatchedLines: [2] },
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

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
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

/** Il campo del testo ufficiale nella scheda (non quello dell'editor, che sta nel dialogo). */
function lyricsField(scope: HTMLElement) {
  return scope.querySelector<HTMLTextAreaElement>('textarea');
}

function requestBody(init: FetchInit | undefined) {
  return JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
}

function callsTo(path: string) {
  return mocks.apiFetch.mock.calls.filter(([called]) => called === path);
}

/** Apre il blocco, incolla il testo e preme «Allinea con Solco AI». */
async function alignWith(eligible: HTMLElement, lyrics: string) {
  await click(button(eligible, 'Ho il testo: allinea'));
  const field = lyricsField(eligible);
  if (!field) throw new Error('Campo del testo non trovato.');
  await typeInto(field, lyrics);
  await click(button(eligible, 'Allinea con Solco AI'));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.toast.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
  mocks.writeText.mockReset();
  handlers = { [REPORT]: respondWith(report()) };
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

describe('«Ho il testo: allinea»: dove compare e che cosa mostra', () => {
  it('solo sui brani con "testo": true; aperto, mostra il campo con la nota, senza richieste', async () => {
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    const toggle = button(eligible, 'Ho il testo: allinea');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(lyricsField(eligible)).toBeNull();

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const field = lyricsField(eligible);
    expect(field).not.toBeNull();
    const label = eligible.querySelector(`label[for="${field?.id}"]`);
    expect(label?.textContent).toBe('Testo ufficiale del brano (una riga per verso)');
    expect(eligible.textContent).toContain(
      'Solco AI prende i tempi dall’audio e li mette sulle tue parole',
    );
    expect(eligible.textContent).toContain('Il testo non si conserva sul server.');
    expect(callsTo(ALIGN)).toHaveLength(0);

    await click(button(eligible, 'Chiudi'));
    expect(lyricsField(eligible)).toBeNull();

    for (const title of ['Band — Inno', 'Ignoto — Copiato']) {
      expect(maybeButton(article(container, title), 'Ho il testo')).toBeUndefined();
    }
  });

  it('testo vuoto: errore in linea sotto il campo, nessuna richiesta', async () => {
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    await click(button(eligible, 'Ho il testo: allinea'));
    await click(button(eligible, 'Allinea con Solco AI'));
    const alert = eligible.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('Incolla il testo del brano, una riga per verso.');
    const field = lyricsField(eligible);
    expect(field?.getAttribute('aria-invalid')).toBe('true');
    expect(field?.getAttribute('aria-describedby')).toContain(alert?.id ?? '§');
    expect(callsTo(ALIGN)).toHaveLength(0);

    // Scrivere toglie l'errore.
    await typeInto(field as HTMLTextAreaElement, 'Una riga');
    expect(eligible.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('«Allinea con Solco AI»: richiesta ed editor', () => {
  it('testo e lingua inviati, avanzamento con «Annulla», poi editor con il testo allineato e le note', async () => {
    const request = pending();
    handlers[ALIGN] = request.handler;
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    await choose(eligible.querySelector('select') as HTMLSelectElement, 'it');
    await alignWith(eligible, OFFICIAL);

    const [path, init] = callsTo(ALIGN)[0] as [string, FetchInit];
    expect(path).toBe(ALIGN);
    expect(init.method).toBe('POST');
    expect(requestBody(init)).toEqual({ pathname: SONG, lyrics: OFFICIAL, language: 'it' });
    expect(init.schema).toBe(TranscribeResponseSchema);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(callsTo(TRANSCRIBE)).toHaveLength(0);

    const section = eligible.querySelector('section');
    expect(section?.getAttribute('aria-busy')).toBe('true');
    expect(eligible.textContent).toContain(
      'Allineamento in corso… può richiedere fino a un minuto',
    );
    expect(maybeButton(eligible, 'Annulla')).toBeDefined();
    expect(lyricsField(eligible)).toBeNull();

    await act(async () => request.resolve(ALIGNED));
    await flush();
    expect(section?.getAttribute('aria-busy')).toBe('false');
    // Il blocco del testo si chiude: la bozza è nell'editor.
    expect(lyricsField(eligible)).toBeNull();
    const editor = dialog();
    expect(editor).not.toBeNull();
    expect(editor?.textContent).toContain(
      'Il tuo testo con i tempi di Solco AI: controlla i tempi prima di salvare.',
    );
    expect(editor?.querySelector('textarea')?.value).toBe(ALIGNED.draft);
    expect(editor?.textContent).toContain(
      'Allineato al tuo testo: 93% delle parole (13 su 14) ha un tempo preso dall’audio',
    );
    expect(editor?.textContent).toContain('Righe senza riscontro nell’audio: 2');
    expect(editor?.textContent).toContain(TRANSCRIPTION_ALIGNED_HINT);
    expect(editor?.textContent).toContain('Tempi parola per parola');
    expect(editor?.textContent).not.toContain('Righe da controllare');
    expect(editor?.textContent).toContain(
      '2 righe lette dal player (sincronizzato, parola per parola)',
    );
    expect(editor?.textContent).toContain('Dalla cache · nessun credito usato');
    expect(mocks.success).toHaveBeenCalledWith(
      'Testo allineato: 2 righe, 93% delle parole con un tempo preso dall’audio.',
    );
  });

  it('il 400 del server sul campo lyrics resta sotto il testo, con il blocco aperto e il testo intatto', async () => {
    const message =
      "Il testo trova riscontro solo nel 12% delle parole riconosciute nell'audio: controlla che sia il testo di questo brano.";
    handlers[ALIGN] = async () => {
      throw apiError(ALIGN, 400, { error: 'align_no_match', errors: { lyrics: message } });
    };
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    await alignWith(eligible, OFFICIAL);

    expect(eligible.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
    const field = lyricsField(eligible);
    expect(field?.value).toBe(OFFICIAL);
    expect(eligible.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(mocks.error).toHaveBeenCalledWith(message);
    expect(dialog()).toBeNull();
    // Il pulsante della trascrizione resta disponibile: l'errore è solo sul testo.
    expect(button(eligible, 'Trascrivi con Solco AI').disabled).toBe(false);
  });

  it('un altro errore del server: messaggio della scheda e avviso, come la trascrizione', async () => {
    handlers[ALIGN] = async () => {
      throw apiError(ALIGN, 503, {
        error: 'store_unavailable',
        message:
          'Non riesco a leggere lo store o diritti.json in questo momento: riprova tra poco.',
      });
    };
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    await alignWith(eligible, OFFICIAL);
    expect(eligible.querySelector('[role="alert"]')?.textContent).toBe(
      'Non riesco a leggere lo store o diritti.json in questo momento: riprova tra poco.',
    );
    expect(mocks.error).toHaveBeenCalledTimes(1);
  });

  it('«Annulla» interrompe l’allineamento', async () => {
    const request = pending();
    handlers[ALIGN] = request.handler;
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    await alignWith(eligible, OFFICIAL);
    await click(button(eligible, 'Annulla'));
    expect(request.calls[0]?.signal?.aborted).toBe(true);
    expect(eligible.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
    expect(mocks.toast).toHaveBeenCalledWith('Allineamento annullato.');
    expect(dialog()).toBeNull();
  });

  it('bozza modificata: chiede conferma prima di sostituirla con il testo allineato', async () => {
    handlers[TRANSCRIBE] = respondWith(DRAFT);
    const align = pending();
    handlers[ALIGN] = align.handler;
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    await click(button(eligible, 'Trascrivi con Solco AI'));
    const editor = dialog();
    expect(editor).not.toBeNull();
    await typeInto(editor?.querySelector('textarea') as HTMLTextAreaElement, '[00:12.30] Corretta');
    await click(button(editor as HTMLElement, 'Annulla'));
    expect(dialog()).toBeNull();

    await alignWith(eligible, OFFICIAL);
    expect(callsTo(ALIGN)).toHaveLength(0);
    expect(eligible.textContent).toContain(
      'Hai una bozza modificata: sostituirla con il tuo testo allineato? Le tue correzioni andrebbero perse.',
    );
    expect(maybeButton(eligible, 'Rigenera con Solco AI')).toBeUndefined();

    await click(button(eligible, 'Tieni la bozza'));
    expect(callsTo(ALIGN)).toHaveLength(0);
    expect(eligible.textContent).not.toContain('Hai una bozza modificata');

    await click(button(eligible, 'Allinea con Solco AI'));
    await click(button(eligible, 'Sì, allinea il testo'));
    expect(callsTo(ALIGN)).toHaveLength(1);
    expect(requestBody(align.calls[0])).toEqual({ pathname: SONG, lyrics: OFFICIAL });
  });
});

describe('«Copia il testo» nell’editor', () => {
  it('copia il testo dell’editor negli appunti e avvisa', async () => {
    handlers[TRANSCRIBE] = respondWith(DRAFT);
    mocks.writeText.mockResolvedValue(undefined);
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    await click(button(eligible, 'Trascrivi con Solco AI'));
    const editor = dialog() as HTMLElement;
    await typeInto(editor.querySelector('textarea') as HTMLTextAreaElement, '[00:12.30] Mia riga');
    await click(button(editor, 'Copia il testo'));
    expect(mocks.writeText).toHaveBeenCalledWith('[00:12.30] Mia riga');
    expect(mocks.success).toHaveBeenCalledWith('Testo copiato negli appunti.');
    expect(dialog()).not.toBeNull();
  });

  it('appunti non disponibili: avviso di errore, nessun crash', async () => {
    handlers[TRANSCRIBE] = respondWith(DRAFT);
    mocks.writeText.mockRejectedValue(new Error('denied'));
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    await click(button(eligible, 'Trascrivi con Solco AI'));
    await click(button(dialog() as HTMLElement, 'Copia il testo'));
    expect(mocks.error).toHaveBeenCalledWith(
      'Copia non riuscita: seleziona il testo nell’editor e copialo a mano.',
    );
  });
});
