// @polsia:user-owned — pagina /admin/diritti-testi, trascrizione IA: il pulsante «Trascrivi con
// l'IA» compare SOLO sui brani dichiarati con "testo": true (mai sugli altri); spento con il
// motivo senza GROQ_API_KEY o con un formato non accettato; lingua scelta inviata; avanzamento
// con aria-busy e «Annulla» che interrompe la richiesta; errori in linea + avviso; editor con la
// bozza, righe lette e segmenti scartati; «Salva come .lrc», conferma prima di sostituire un .lrc
// esistente (anche dopo un 409 del server), «Annulla» e «Riapri la bozza». Cache cifrata: badge
// «Dalla cache» / «Nuova trascrizione», «Rigenera con Solco AI» con la domanda sui crediti (ricontrolla
// le correzioni alla conferma), e con una bozza modificata la domanda dice se si ricarica la bozza
// conservata (stessa lingua) o se si chiede una trascrizione nuova.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/diritti-testi' }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: null }) }));
vi.mock('sonner', () => ({
  toast: Object.assign(mocks.toast, { success: mocks.success, error: mocks.error }),
}));

import { FeaturedRightsDashboard } from '@/components/custom/admin/featured-rights-dashboard';
import {
  type AdminFeaturedRights,
  AdminFeaturedRightsSchema,
  type FeaturedRightsTrack,
} from '@/lib/contracts/admin-featured-rights';
import {
  SaveLyricsResponseSchema,
  type TranscribeResponse,
  TranscribeResponseSchema,
} from '@/lib/contracts/lyrics-transcription';

const NOW = '2026-11-14T14:30:00.000Z';
const REPORT = '/api/admin/featured-rights';
const TRANSCRIBE = '/api/admin/featured-rights/transcribe';
const SAVE = '/api/admin/featured-rights/transcribe/save';

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

const lyricsOn = {
  declared: true,
  licenza: 'propria',
  titolare: 'Autrice',
  testo: true,
  lyrics: { status: 'none' },
} as const;

const TRACKS: FeaturedRightsTrack[] = [
  row('Cantautori/Autrice - Canzone.mp3', { ...lyricsOn, transcription: 'ready' }),
  row('Cantautori/Autrice - Ballata.mp3', {
    ...lyricsOn,
    sidecars: { lrc: true, txt: false },
    lyrics: { status: 'lrc', kind: 'synced', lineCount: 3 },
    transcription: 'ready',
  }),
  row('Voce/Autrice - Sussurro.opus', { ...lyricsOn, transcription: 'unsupported_format' }),
  row('Rock/Band - Inno.mp3', { declared: true, licenza: 'propria', titolare: 'Band' }),
  row('Pop/Ignoto - Copiato.mp3', { sidecars: { lrc: true, txt: false } }),
];

function report(extra: Partial<AdminFeaturedRights> = {}): AdminFeaturedRights {
  return {
    generatedAt: NOW,
    store: { status: 'ok', listedAt: NOW, reason: null },
    manifest: {
      status: 'valid',
      reasons: [],
      location: null,
      counts: { entries: 4, valid: 4, invalid: 0, ignored: 0 },
      problems: [],
    },
    summary: {
      totalTracks: 5,
      declared: 4,
      declaredWithLyrics: 3,
      lyricsFound: 1,
      lyricsMissing: 2,
      lyricsErrors: 0,
      lyricsSkipped: 0,
      lyricsNotShown: 0,
      manifestProblems: 0,
    },
    tracks: TRACKS,
    tracksTruncated: false,
    transcriptionAvailable: true,
    ...extra,
  };
}

const DRAFT: TranscribeResponse = {
  draft: '[00:12.30] Prima strofa\n[00:20.00] Ritornello\n[00:28.00] Ritornello',
  lineCount: 3,
  language: 'italian',
  durationSeconds: 184.4,
  droppedSegments: 2,
  uncertainLines: [2],
  wordTimed: false,
  fromCache: false,
  cachedAt: '2026-11-14T14:31:00.000Z',
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

async function submit(element: HTMLElement) {
  const form = element.closest('form');
  if (!form) throw new Error('Modulo non trovato.');
  await act(async () => {
    form.requestSubmit(element as HTMLButtonElement);
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

function requestBody(init: FetchInit | undefined) {
  return JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
}

function callsTo(path: string) {
  return mocks.apiFetch.mock.calls.filter(([called]) => called === path);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.toast.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
  handlers = { [REPORT]: respondWith(report()) };
  mocks.apiFetch.mockImplementation((path: string, init?: FetchInit) => route(path, init));
});

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('trascrizione IA: dove compare', () => {
  it('SOLO sui brani con "testo": true; mai sui non dichiarati o senza testo', async () => {
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    expect(eligible.textContent).toContain('Trascrizione con Solco AI');
    const start = button(eligible, 'Trascrivi con Solco AI');
    expect(start.disabled).toBe(false);
    expect(eligible.textContent).toContain(
      "L'audio viene inviato a Solco AI solo per la trascrizione.",
    );
    expect(eligible.querySelector('select')?.value).toBe('');

    for (const title of ['Band — Inno', 'Ignoto — Copiato']) {
      const other = article(container, title);
      expect(other.textContent).not.toContain('Trascri');
      expect(other.querySelector('select')).toBeNull();
      expect(maybeButton(other, 'Trascrivi')).toBeUndefined();
    }
  });

  it('senza GROQ_API_KEY: pulsante spento con il motivo, nessuna richiesta', async () => {
    handlers[REPORT] = respondWith(report({ transcriptionAvailable: undefined }));
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    const start = button(eligible, 'Trascrivi con Solco AI');
    expect(start.disabled).toBe(true);
    const reasonId = start.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId ?? '')?.textContent).toBe(
      'Aggiungi GROQ_API_KEY su Vercel per usare Solco AI (trascrizione dei testi)',
    );
    await click(start);
    expect(callsTo(TRANSCRIBE)).toHaveLength(0);
  });

  it('formato non accettato da Whisper: pulsante spento con il motivo', async () => {
    const container = await mount();
    const opus = article(container, 'Autrice — Sussurro');
    const start = button(opus, 'Trascrivi con Solco AI');
    expect(start.disabled).toBe(true);
    expect(opus.textContent).toContain('Formato .opus non supportato dalla trascrizione');
    expect(opus.querySelector('select')).toBeNull();
  });
});

describe('trascrizione IA: richiesta', () => {
  it('lingua scelta, avanzamento con aria-busy, poi editor con la bozza', async () => {
    const request = pending();
    handlers[TRANSCRIBE] = request.handler;
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    const select = eligible.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Automatica',
      'Italiano',
      'English',
      'Español',
      'Français',
      'Deutsch',
      'Português',
    ]);
    await choose(select, 'it');
    await click(button(eligible, 'Trascrivi con Solco AI'));

    const [path, init] = callsTo(TRANSCRIBE)[0] as [string, FetchInit];
    expect(path).toBe(TRANSCRIBE);
    expect(init.method).toBe('POST');
    expect(requestBody(init)).toEqual({
      pathname: 'Cantautori/Autrice - Canzone.mp3',
      language: 'it',
    });
    expect(init.schema).toBe(TranscribeResponseSchema);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const section = eligible.querySelector('section');
    expect(section?.getAttribute('aria-busy')).toBe('true');
    expect(eligible.textContent).toContain(
      'Trascrizione in corso… può richiedere fino a un minuto',
    );
    expect(maybeButton(eligible, 'Trascrivi con Solco AI')).toBeUndefined();

    await act(async () => request.resolve(DRAFT));
    await flush();
    expect(section?.getAttribute('aria-busy')).toBe('false');
    const editor = dialog();
    expect(editor).not.toBeNull();
    expect(editor?.textContent).toContain('Testo di Autrice — Canzone');
    expect(editor?.textContent).toContain(
      'Bozza automatica: controlla parole e tempi prima di salvare.',
    );
    expect(editor?.querySelector('textarea')?.value).toBe(DRAFT.draft);
    expect(editor?.textContent).toContain('3 righe lette dal player (sincronizzato)');
    expect(editor?.textContent).toContain('Lingua riconosciuta: italiano');
    expect(editor?.textContent).toContain('2 segmenti scartati');
    expect(editor?.textContent).toContain('Righe da controllare: 2');
    expect(editor?.textContent).not.toContain('Tempi parola per parola');
    expect(mocks.success).toHaveBeenCalledWith('Bozza pronta: 3 righe.');
  });

  it('lingua automatica: nessun campo "language"', async () => {
    const request = pending();
    handlers[TRANSCRIBE] = request.handler;
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    expect(requestBody(request.calls[0])).toEqual({ pathname: 'Cantautori/Autrice - Canzone.mp3' });
  });

  it('«Annulla» interrompe la richiesta e torna al pulsante', async () => {
    const request = pending();
    handlers[TRANSCRIBE] = request.handler;
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    await click(button(eligible, 'Trascrivi con Solco AI'));
    await click(button(eligible, 'Annulla'));
    expect(request.calls[0]?.signal?.aborted).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith('Trascrizione annullata.');
    expect(mocks.error).not.toHaveBeenCalled();
    expect(eligible.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
    expect(button(eligible, 'Trascrivi con Solco AI').disabled).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('errore: messaggio del server in linea e nell’avviso', async () => {
    const message = 'Trascrizione non riuscita: limite OpenAI raggiunto, riprova più tardi.';
    handlers[TRANSCRIBE] = async () => {
      throw apiError(TRANSCRIBE, 429, { error: 'transcription_rate_limited', message });
    };
    const container = await mount();
    const eligible = article(container, 'Autrice — Canzone');
    await click(button(eligible, 'Trascrivi con Solco AI'));
    expect(eligible.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(mocks.error).toHaveBeenCalledWith(message);
    expect(dialog()).toBeNull();
  });
});

describe('trascrizione IA: editor e salvataggio', () => {
  async function openEditor(title = 'Autrice — Canzone') {
    handlers[TRANSCRIBE] = respondWith(DRAFT);
    const container = await mount();
    const card = article(container, title);
    await click(button(card, 'Trascrivi con Solco AI'));
    const editor = dialog();
    if (!editor) throw new Error('Editor non aperto.');
    return { container, card, editor };
  }

  it('«Salva come .lrc»: invia il testo rivisto, chiude e dice entro quando compare', async () => {
    handlers[SAVE] = respondWith({ saved: true, visibleWithinMinutes: 5 });
    const { card, editor } = await openEditor();
    const textarea = editor.querySelector('textarea') as HTMLTextAreaElement;
    await typeInto(textarea, '[00:12.30] Prima strofa corretta\n[00:20.00] Ritornello');
    expect(editor.textContent).toContain('2 righe lette dal player (sincronizzato)');
    await submit(button(editor, 'Salva come .lrc'));

    const [, init] = callsTo(SAVE)[0] as [string, FetchInit];
    expect(init.method).toBe('POST');
    expect(init.schema).toBe(SaveLyricsResponseSchema);
    expect(requestBody(init)).toEqual({
      pathname: 'Cantautori/Autrice - Canzone.mp3',
      lrc: '[00:12.30] Prima strofa corretta\n[00:20.00] Ritornello',
      overwrite: false,
    });
    expect(dialog()).toBeNull();
    const note =
      'Testo salvato come “Cantautori/Autrice - Canzone.lrc”: compare nel player entro ~5 minuti.';
    expect(mocks.success).toHaveBeenCalledWith(note);
    expect(card.textContent).toContain(note);
    expect(maybeButton(card, 'Riapri la bozza')).toBeUndefined();
  });

  it('testo vuoto: errore in linea, nessuna richiesta', async () => {
    handlers[SAVE] = respondWith({ saved: true, visibleWithinMinutes: 5 });
    const { editor } = await openEditor();
    await typeInto(editor.querySelector('textarea') as HTMLTextAreaElement, '   ');
    expect(editor.textContent).toContain('Nessuna riga leggibile');
    await submit(button(editor, 'Salva come .lrc'));
    expect(editor.textContent).toContain('Il testo è vuoto: scrivi almeno una riga.');
    expect(callsTo(SAVE)).toHaveLength(0);
  });

  it('.lrc già presente: prima la conferma, poi la sostituzione con overwrite', async () => {
    handlers[SAVE] = respondWith({ saved: true, visibleWithinMinutes: 5 });
    const { editor } = await openEditor('Autrice — Ballata');
    await submit(button(editor, 'Salva come .lrc'));
    expect(callsTo(SAVE)).toHaveLength(0);
    expect(editor.textContent).toContain('salvando sostituisci “Cantautori/Autrice - Ballata.lrc”');
    await submit(button(editor, 'Sostituisci il .lrc'));
    expect(requestBody(callsTo(SAVE)[0]?.[1] as FetchInit).overwrite).toBe(true);
    expect(dialog()).toBeNull();
  });

  it('409 del server: errore sul campo, poi conferma esplicita', async () => {
    let attempt = 0;
    handlers[SAVE] = async (init) => {
      attempt += 1;
      if (attempt === 1) {
        throw apiError(SAVE, 409, {
          error: 'lrc_exists',
          errors: { lrc: 'Esiste già un .lrc: conferma per sostituirlo' },
        });
      }
      return init.schema?.parse({ saved: true, visibleWithinMinutes: 5 });
    };
    const { editor } = await openEditor();
    await submit(button(editor, 'Salva come .lrc'));
    expect(editor.textContent).toContain('Esiste già un .lrc: conferma per sostituirlo');
    expect(mocks.error).not.toHaveBeenCalled();
    await submit(button(editor, 'Sostituisci il .lrc'));
    expect(callsTo(SAVE).map(([, init]) => requestBody(init as FetchInit).overwrite)).toEqual([
      false,
      true,
    ]);
  });

  it('errore generico del salvataggio: in linea e nell’avviso, l’editor resta aperto', async () => {
    const message =
      'Salvataggio non riuscito: lo store non ha accettato il file. Riprova tra poco.';
    handlers[SAVE] = async () => {
      throw apiError(SAVE, 502, { error: 'save_failed', message });
    };
    const { editor } = await openEditor();
    await submit(button(editor, 'Salva come .lrc'));
    expect(editor.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(mocks.error).toHaveBeenCalledWith(message);
    expect(dialog()).not.toBeNull();
  });

  it('«Annulla» chiude l’editor; «Riapri la bozza» lo riapre con le modifiche', async () => {
    const { card, editor } = await openEditor();
    await typeInto(editor.querySelector('textarea') as HTMLTextAreaElement, '[00:01.00] Rivista');
    await click(button(editor, 'Annulla'));
    expect(dialog()).toBeNull();
    await click(button(card, 'Riapri la bozza'));
    expect(dialog()?.querySelector('textarea')?.value).toBe('[00:01.00] Rivista');
  });
});

async function search(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error('Ricerca non trovata.');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

function hasArticle(container: HTMLElement, title: string) {
  return [...container.querySelectorAll('article h3')].some((h3) => h3.textContent === title);
}

/** Radix rimette il fuoco con un setTimeout(0) dopo la chiusura del dialogo. */
async function settleFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush();
}

describe('trascrizione IA: stato che sopravvive a filtri e ricerca', () => {
  it('ricerca durante la trascrizione: la richiesta continua e la bozza resta', async () => {
    const request = pending();
    handlers[TRANSCRIBE] = request.handler;
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    await search(container, 'Ballata');
    expect(hasArticle(container, 'Autrice — Canzone')).toBe(false);
    expect(request.calls[0]?.signal?.aborted).toBe(false);

    await act(async () => request.resolve(DRAFT));
    await flush();
    // Scheda nascosta: niente editor che si apre da solo, ma un avviso col nome del brano.
    expect(dialog()).toBeNull();
    expect(mocks.success).toHaveBeenCalledWith(
      'Bozza pronta per Autrice — Canzone: 3 righe. La trovi con «Riapri la bozza» nella sua scheda.',
    );
    expect(mocks.toast).not.toHaveBeenCalledWith('Trascrizione annullata.');

    await search(container, '');
    const card = article(container, 'Autrice — Canzone');
    await click(button(card, 'Riapri la bozza'));
    expect(dialog()?.querySelector('textarea')?.value).toBe(DRAFT.draft);
    expect(callsTo(TRANSCRIBE)).toHaveLength(1);
  });

  it('ricerca mentre la richiesta è in corso: al ritorno la scheda è ancora "in corso"', async () => {
    const request = pending();
    handlers[TRANSCRIBE] = request.handler;
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    await search(container, 'Ballata');
    await search(container, '');
    const card = article(container, 'Autrice — Canzone');
    expect(card.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    await click(button(card, 'Annulla'));
    expect(request.calls[0]?.signal?.aborted).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith('Trascrizione annullata.');
  });

  it('le correzioni nell’editor sopravvivono a un filtro', async () => {
    handlers[TRANSCRIBE] = respondWith(DRAFT);
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    await typeInto(dialog()?.querySelector('textarea') as HTMLTextAreaElement, '[00:01.00] Mia');
    await click(button(dialog() as HTMLElement, 'Annulla'));
    await click(button(container, 'Testo trovato'));
    expect(hasArticle(container, 'Autrice — Canzone')).toBe(false);
    await click(button(container, 'Tutti'));
    await click(button(article(container, 'Autrice — Canzone'), 'Riapri la bozza'));
    expect(dialog()?.querySelector('textarea')?.value).toBe('[00:01.00] Mia');
  });

  it('uscendo dalla pagina la richiesta si interrompe senza avvisi', async () => {
    const request = pending();
    handlers[TRANSCRIBE] = request.handler;
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    for (const { root } of roots.splice(0)) await act(async () => root.unmount());
    container.remove();
    await flush();
    expect(request.calls[0]?.signal?.aborted).toBe(true);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});

describe('trascrizione IA: nuova trascrizione con una bozza già presente', () => {
  const SECOND: TranscribeResponse = { ...DRAFT, draft: '[00:05.00] Seconda versione' };
  /** Quello che il server risponde davvero a una nuova richiesta con la stessa chiave: la cache. */
  const STORED: TranscribeResponse = { ...DRAFT, fromCache: true };

  /** Bozza `first` modificata e editor chiuso; le richieste dopo rispondono con `next`, in ordine. */
  async function withEditedDraft(first: TranscribeResponse = DRAFT, next = [STORED]) {
    const queue = [first, ...next];
    handlers[TRANSCRIBE] = async (init) => init.schema?.parse(queue.shift() ?? first);
    const container = await mount();
    const card = article(container, 'Autrice — Canzone');
    await click(button(card, 'Trascrivi con Solco AI'));
    await typeInto(
      dialog()?.querySelector('textarea') as HTMLTextAreaElement,
      '[00:01.00] Correzione manuale',
    );
    await click(button(dialog() as HTMLElement, 'Annulla'));
    await settleFocus();
    return { container, card };
  }

  it('bozza modificata: chiede prima di sostituirla; «Tieni la bozza» non chiama OpenAI', async () => {
    const { card } = await withEditedDraft();
    await click(button(card, 'Trascrivi con Solco AI'));
    expect(callsTo(TRANSCRIBE)).toHaveLength(1);
    expect(card.textContent).toContain(
      'Hai una bozza modificata: ricaricare la bozza conservata sul server?',
    );
    const keep = button(card, 'Tieni la bozza');
    expect(document.activeElement).toBe(keep);
    await click(keep);
    expect(card.textContent).not.toContain('Hai una bozza modificata');
    expect(document.activeElement).toBe(button(card, 'Trascrivi con Solco AI'));
    expect(callsTo(TRANSCRIBE)).toHaveLength(1);
    await click(button(card, 'Riapri la bozza'));
    expect(dialog()?.querySelector('textarea')?.value).toBe('[00:01.00] Correzione manuale');
  });

  it('stessa lingua di una bozza conservata: la domanda dice che si ricarica QUELLA bozza, non una nuova', async () => {
    const { card } = await withEditedDraft();
    await click(button(card, 'Trascrivi con Solco AI'));
    expect(card.textContent).toContain(
      'Hai una bozza modificata: ricaricare la bozza conservata sul server? Le tue correzioni andrebbero perse. Per una trascrizione nuova usa «Rigenera con Solco AI».',
    );
    expect(card.textContent).not.toContain('sostituirla con una nuova trascrizione');
    expect(maybeButton(card, 'Sì, trascrivi di nuovo')).toBeUndefined();
    await click(button(card, 'Sì, ricarica la bozza'));
    expect(callsTo(TRANSCRIBE)).toHaveLength(2);
    // Nessuna rigenerazione: il server risponde dalla cache con la stessa bozza.
    expect(requestBody(callsTo(TRANSCRIBE)[1]?.[1] as FetchInit)).toEqual({
      pathname: 'Cantautori/Autrice - Canzone.mp3',
    });
    const editor = dialog() as HTMLElement;
    expect(editor.querySelector('textarea')?.value).toBe(DRAFT.draft);
    expect(editor.textContent).toContain('Dalla cache · nessun credito usato');
  });

  it('dalla domanda, «Rigenera con Solco AI» chiede dei crediti e poi rifà la trascrizione (regenerate)', async () => {
    const { card } = await withEditedDraft(DRAFT, [SECOND]);
    await click(button(card, 'Trascrivi con Solco AI'));
    await click(button(card, 'Rigenera con Solco AI'));
    expect(card.textContent).toContain(
      'Usa di nuovo Solco AI per questo brano? Le correzioni fatte nell’editor andrebbero perse.',
    );
    expect(callsTo(TRANSCRIBE)).toHaveLength(1);
    await click(button(card, 'Sì, rigenera'));
    expect(requestBody(callsTo(TRANSCRIBE)[1]?.[1] as FetchInit)).toEqual({
      pathname: 'Cantautori/Autrice - Canzone.mp3',
      regenerate: true,
    });
    expect(dialog()?.querySelector('textarea')?.value).toBe(SECOND.draft);
  });

  it('lingua diversa: «Sì, trascrivi di nuovo» chiede la trascrizione in quella lingua', async () => {
    const { card } = await withEditedDraft(DRAFT, [SECOND]);
    await choose(card.querySelector('select') as HTMLSelectElement, 'en');
    await click(button(card, 'Trascrivi con Solco AI'));
    expect(card.textContent).toContain(
      'Hai una bozza modificata: sostituirla con una nuova trascrizione?',
    );
    expect(maybeButton(card, 'Rigenera con Solco AI')).toBeUndefined();
    await click(button(card, 'Sì, trascrivi di nuovo'));
    expect(requestBody(callsTo(TRANSCRIBE)[1]?.[1] as FetchInit)).toEqual({
      pathname: 'Cantautori/Autrice - Canzone.mp3',
      language: 'en',
    });
    expect(dialog()?.querySelector('textarea')?.value).toBe(SECOND.draft);
  });

  it('bozza non confermata sul server (cachedAt null): si chiede una nuova trascrizione', async () => {
    const { card } = await withEditedDraft({ ...DRAFT, cachedAt: null }, [SECOND]);
    await click(button(card, 'Trascrivi con Solco AI'));
    expect(card.textContent).toContain(
      'Hai una bozza modificata: sostituirla con una nuova trascrizione?',
    );
    await click(button(card, 'Sì, trascrivi di nuovo'));
    expect(callsTo(TRANSCRIBE)).toHaveLength(2);
    expect(dialog()?.querySelector('textarea')?.value).toBe(SECOND.draft);
  });

  it('bozza NON modificata: nessuna domanda, si trascrive di nuovo', async () => {
    handlers[TRANSCRIBE] = respondWith(DRAFT);
    const container = await mount();
    const card = article(container, 'Autrice — Canzone');
    await click(button(card, 'Trascrivi con Solco AI'));
    await click(button(dialog() as HTMLElement, 'Annulla'));
    await click(button(card, 'Trascrivi con Solco AI'));
    expect(card.textContent).not.toContain('Hai una bozza modificata');
    expect(callsTo(TRANSCRIBE)).toHaveLength(2);
  });
});

describe('trascrizione IA: fuoco, lingua riconosciuta, file troppo grandi', () => {
  it('chiudendo l’editor il fuoco torna nella scheda (mai su <body>)', async () => {
    handlers[TRANSCRIBE] = respondWith(DRAFT);
    handlers[SAVE] = respondWith({ saved: true, visibleWithinMinutes: 5 });
    const container = await mount();
    const card = article(container, 'Autrice — Canzone');
    await click(button(card, 'Trascrivi con Solco AI'));
    await click(button(dialog() as HTMLElement, 'Annulla'));
    await settleFocus();
    expect(document.activeElement).toBe(button(card, 'Riapri la bozza'));

    await click(button(card, 'Riapri la bozza'));
    await submit(button(dialog() as HTMLElement, 'Salva come .lrc'));
    await settleFocus();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button(card, 'Trascrivi con Solco AI'));
  });

  it('lingua riconosciuta in italiano anche fuori dal menu; sconosciuta → nessuna riga', async () => {
    handlers[TRANSCRIBE] = respondWith({ ...DRAFT, language: 'japanese' });
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    expect(dialog()?.textContent).toContain('Lingua riconosciuta: giapponese');
    expect(dialog()?.textContent).not.toContain('japanese');
    await click(button(dialog() as HTMLElement, 'Annulla'));

    handlers[TRANSCRIBE] = respondWith({ ...DRAFT, language: 'klingon' });
    await click(button(article(container, 'Autrice — Ballata'), 'Trascrivi con Solco AI'));
    expect(dialog()?.textContent).toContain('Testo di Autrice — Ballata');
    expect(dialog()?.textContent).not.toContain('Lingua riconosciuta');
    expect(dialog()?.textContent).not.toContain('klingon');
  });

  it('file oltre 25 MB: pulsante spento col motivo, nessuna richiesta', async () => {
    handlers[REPORT] = respondWith(
      report({
        tracks: [
          ...TRACKS,
          row('Grande/Autrice - Lunga.wav', { ...lyricsOn, transcription: 'too_large' }),
        ],
      }),
    );
    const container = await mount();
    const card = article(container, 'Autrice — Lunga');
    const start = button(card, 'Trascrivi con Solco AI');
    expect(start.disabled).toBe(true);
    expect(document.getElementById(start.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'File oltre 25 MB: la trascrizione non è disponibile.',
    );
    expect(card.querySelector('select')).toBeNull();
    await click(start);
    expect(callsTo(TRANSCRIBE)).toHaveLength(0);
  });
});

describe('trascrizione IA: cache cifrata sul server', () => {
  const CACHED: TranscribeResponse = {
    ...DRAFT,
    fromCache: true,
    cachedAt: '2026-11-12T09:05:00.000Z',
  };
  const FRESH: TranscribeResponse = { ...DRAFT, draft: '[00:03.00] Rigenerata', lineCount: 1 };

  it('bozza nuova: «Nuova trascrizione · salvata in modo cifrato», nessun «Rigenera»', async () => {
    handlers[TRANSCRIBE] = respondWith(DRAFT);
    const container = await mount();
    const card = article(container, 'Autrice — Canzone');
    await click(button(card, 'Trascrivi con Solco AI'));
    const editor = dialog() as HTMLElement;
    expect(editor.textContent).toContain('Nuova trascrizione · salvata in modo cifrato');
    expect(editor.textContent).not.toContain('Dalla cache');
    expect(maybeButton(editor, 'Rigenera con Solco AI')).toBeUndefined();
    await click(button(editor, 'Annulla'));
    expect(card.textContent).toContain('Nuova trascrizione · salvata in modo cifrato');
  });

  it('bozza nuova senza conferma del salvataggio (cachedAt null): "non confermato", senza promettere né escludere la cache', async () => {
    handlers[TRANSCRIBE] = respondWith({ ...DRAFT, cachedAt: null });
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    const editor = dialog() as HTMLElement;
    expect(editor.textContent).toContain('Nuova trascrizione · salvataggio cifrato non confermato');
    expect(editor.textContent).toContain(
      'Il server non ha confermato di averla conservata cifrata: una nuova richiesta potrebbe chiamare di nuovo Solco AI.',
    );
    expect(editor.textContent).not.toContain('salvata in modo cifrato');
    expect(editor.textContent).not.toContain('non salvata sul server');
  });

  it('bozza dalla cache: badge, data della trascrizione e avviso senza crediti', async () => {
    handlers[TRANSCRIBE] = respondWith(CACHED);
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    const editor = dialog() as HTMLElement;
    expect(editor.textContent).toContain('Dalla cache · nessun credito usato');
    // 09:05 UTC = 10:05 a Roma (ora solare).
    expect(editor.textContent).toContain('Trascritta il 12 novembre 2026 alle 10:05');
    expect(editor.querySelector('time')?.getAttribute('dateTime')).toBe(CACHED.cachedAt);
    expect(editor.querySelector('textarea')?.value).toBe(DRAFT.draft);
    expect(button(editor, 'Rigenera con Solco AI')).toBeTruthy();
    expect(mocks.success).toHaveBeenCalledWith('Bozza dalla cache: 3 righe, nessun credito usato.');
  });

  it('«Rigenera con Solco AI»: chiede dei crediti; «No» non chiama OpenAI e torna al pulsante', async () => {
    handlers[TRANSCRIBE] = respondWith(CACHED);
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    const editor = dialog() as HTMLElement;
    await click(button(editor, 'Rigenera con Solco AI'));
    expect(editor.textContent).toContain('Usa di nuovo Solco AI per questo brano?');
    expect(editor.textContent).not.toContain('andrebbero perse');
    const keep = button(editor, 'No, tieni questa');
    expect(document.activeElement).toBe(keep);
    await click(keep);
    expect(editor.textContent).not.toContain('Usa di nuovo Solco AI');
    expect(document.activeElement).toBe(button(editor, 'Rigenera con Solco AI'));
    expect(callsTo(TRANSCRIBE)).toHaveLength(1);
  });

  it('«Sì, rigenera»: regenerate: true con la lingua della bozza, poi la bozza nuova', async () => {
    const regenerated = pending();
    let attempt = 0;
    handlers[TRANSCRIBE] = async (init) => {
      attempt += 1;
      if (attempt === 1) return init.schema?.parse(CACHED);
      return regenerated.handler(init);
    };
    const container = await mount();
    const card = article(container, 'Autrice — Canzone');
    await choose(card.querySelector('select') as HTMLSelectElement, 'it');
    await click(button(card, 'Trascrivi con Solco AI'));
    // La lingua del menu cambia dopo la bozza: la rigenerazione rifà QUELLA trascrizione.
    await click(button(dialog() as HTMLElement, 'Annulla'));
    await choose(card.querySelector('select') as HTMLSelectElement, 'en');
    await click(button(card, 'Riapri la bozza'));
    await click(button(dialog() as HTMLElement, 'Rigenera con Solco AI'));
    await click(button(dialog() as HTMLElement, 'Sì, rigenera'));
    await settleFocus();

    expect(requestBody(callsTo(TRANSCRIBE)[0]?.[1] as FetchInit)).toEqual({
      pathname: 'Cantautori/Autrice - Canzone.mp3',
      language: 'it',
    });
    expect(requestBody(regenerated.calls[0])).toEqual({
      pathname: 'Cantautori/Autrice - Canzone.mp3',
      language: 'it',
      regenerate: true,
    });
    // Durante la richiesta l'editor è chiuso; avanzamento e «Annulla» nella scheda.
    expect(dialog()).toBeNull();
    expect(card.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(button(card, 'Annulla'));

    await act(async () => regenerated.resolve(FRESH));
    await flush();
    const editor = dialog() as HTMLElement;
    expect(editor.querySelector('textarea')?.value).toBe(FRESH.draft);
    expect(editor.textContent).toContain('Nuova trascrizione · salvata in modo cifrato');
    expect(maybeButton(editor, 'Rigenera con Solco AI')).toBeUndefined();
    expect(mocks.success).toHaveBeenLastCalledWith('Bozza pronta: 1 riga.');
  });

  it('con correzioni nell’editor la domanda avvisa che andrebbero perse', async () => {
    handlers[TRANSCRIBE] = respondWith(CACHED);
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    const editor = dialog() as HTMLElement;
    await typeInto(editor.querySelector('textarea') as HTMLTextAreaElement, '[00:01.00] Mia');
    await click(button(editor, 'Rigenera con Solco AI'));
    expect(editor.textContent).toContain(
      'Usa di nuovo Solco AI per questo brano? Le correzioni fatte nell’editor andrebbero perse.',
    );
  });

  it('correzioni scritte mentre la domanda è aperta: prima l’avviso, si rigenera solo confermando di nuovo', async () => {
    const regenerated = pending();
    let attempt = 0;
    handlers[TRANSCRIBE] = async (init) => {
      attempt += 1;
      if (attempt === 1) return init.schema?.parse(CACHED);
      return regenerated.handler(init);
    };
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    const editor = dialog() as HTMLElement;
    await click(button(editor, 'Rigenera con Solco AI'));
    expect(editor.textContent).not.toContain('andrebbero perse');
    const textarea = editor.querySelector('textarea') as HTMLTextAreaElement;
    await typeInto(textarea, '[00:01.00] Mia correzione');
    await click(button(editor, 'Sì, rigenera'));
    // Nessuna richiesta: la domanda ora avvisa delle correzioni e il fuoco va sulla scelta sicura.
    expect(callsTo(TRANSCRIBE)).toHaveLength(1);
    expect(editor.textContent).toContain(
      'Usa di nuovo Solco AI per questo brano? Le correzioni fatte nell’editor andrebbero perse.',
    );
    expect(document.activeElement).toBe(button(editor, 'No, tieni questa'));
    expect(textarea.value).toBe('[00:01.00] Mia correzione');
    await click(button(editor, 'Sì, rigenera'));
    expect(callsTo(TRANSCRIBE)).toHaveLength(2);
    expect(requestBody(regenerated.calls[0])).toEqual({
      pathname: 'Cantautori/Autrice - Canzone.mp3',
      regenerate: true,
    });
  });

  it('nella scheda il badge resta visibile con l’editor chiuso', async () => {
    handlers[TRANSCRIBE] = respondWith(CACHED);
    const container = await mount();
    const card = article(container, 'Autrice — Canzone');
    expect(card.textContent).not.toContain('Dalla cache');
    await click(button(card, 'Trascrivi con Solco AI'));
    await click(button(dialog() as HTMLElement, 'Annulla'));
    expect(card.textContent).toContain('Dalla cache · nessun credito usato');
    expect(card.textContent).toContain('Trascritta il 12 novembre 2026 alle 10:05');
  });

  it('scheda nascosta durante la richiesta: l’avviso dice che viene dalla cache', async () => {
    const request = pending();
    handlers[TRANSCRIBE] = request.handler;
    const container = await mount();
    await click(button(article(container, 'Autrice — Canzone'), 'Trascrivi con Solco AI'));
    await search(container, 'Ballata');
    await act(async () => request.resolve(CACHED));
    await flush();
    expect(mocks.success).toHaveBeenCalledWith(
      'Bozza pronta per Autrice — Canzone (dalla cache, nessun credito usato): 3 righe. La trovi con «Riapri la bozza» nella sua scheda.',
    );
  });

  it('nota a piè di pagina sulla conservazione cifrata (solo se ci sono brani trascrivibili)', async () => {
    const note =
      'Le trascrizioni sono conservate cifrate sul server per non pagarle due volte; quelle non usate per 6 mesi vengono cancellate.';
    const container = await mount();
    expect(container.textContent?.replace(/\s+/g, ' ')).toContain(note);

    handlers[REPORT] = respondWith(
      report({ tracks: TRACKS.map(({ transcription: _unused, ...track }) => track) }),
    );
    const other = await mount();
    expect(other.textContent).not.toContain('conservate cifrate');
  });
});

it('i dati di prova rispettano il contratto', () => {
  expect(() => AdminFeaturedRightsSchema.parse(report())).not.toThrow();
  expect(() => TranscribeResponseSchema.parse(DRAFT)).not.toThrow();
});
