// @polsia:user-owned — pagina /admin/diritti-testi: caricamento, schede di sintesi, stato di
// diritti.json con le voci scartate e la riga/colonna dell'errore, guida, elenco dei brani con
// filtri (Tutti / Dichiarati / Non dichiarati / Testo attivo / Testo trovato / Testo mancante),
// ricerca senza accenti, "Copia percorso" (appunti + avviso), "Mostra altri", errori con
// "Riprova", store non disponibile, "Aggiorna", nessuna scorciatoia per dichiarare in blocco,
// voce nel menu amministrazione e scheda nella panoramica.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  pathname: '/admin/diritti-testi',
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: null }) }));
vi.mock('sonner', () => ({ toast: mocks.toast }));

import AdminPage from '@/app/(dashboard)/admin/page';
import { FeaturedRightsDashboard } from '@/components/custom/admin/featured-rights-dashboard';
import { AdminNav } from '@/components/custom/dashboard/admin-nav';
import {
  type AdminFeaturedRights,
  AdminFeaturedRightsSchema,
  type FeaturedRightsTrack,
} from '@/lib/contracts/admin-featured-rights';

const NOW = new Date('2026-11-14T14:30:00.000Z');
const ENDPOINT = '/api/admin/featured-rights';

function row(pathname: string, extra: Partial<FeaturedRightsTrack> = {}): FeaturedRightsTrack {
  const folder = pathname.includes('/') ? pathname.slice(0, pathname.lastIndexOf('/')) : '';
  const name = pathname.slice(pathname.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const [artist, title] = name.includes(' - ') ? name.split(' - ') : [null, name];
  return {
    pathname,
    folder,
    section: folder || 'In evidenza',
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

const declared = { declared: true, licenza: 'propria', titolare: 'Autrice' } as const;

const TRACKS: FeaturedRightsTrack[] = [
  row('Cantautori/Autrice - Città.mp3', {
    ...declared,
    testo: true,
    sidecars: { lrc: true, txt: false },
    lyrics: { status: 'lrc', kind: 'synced', lineCount: 24 },
  }),
  row('Cantautori/Autrice - Ballata.mp3', {
    ...declared,
    testo: true,
    lyrics: { status: 'none' },
  }),
  row('Rock/Band - Inno.mp3', {
    ...declared,
    licenza: 'licenza',
    titolare: 'Etichetta Srl',
    testo: true,
    lyrics: { status: 'error' },
  }),
  row('Rock/Band - Strumentale.mp3', { ...declared, titolare: 'Band' }),
  row('Pop/Ignoto - Copiato.mp3', { sidecars: { lrc: true, txt: false } }),
  row('Serie/Band - Nuovo.mp3', { ...declared, testo: true, lyrics: { status: 'skipped' } }),
];

function report(extra: Partial<AdminFeaturedRights> = {}): AdminFeaturedRights {
  return {
    generatedAt: NOW.toISOString(),
    store: { status: 'ok', listedAt: NOW.toISOString(), reason: null },
    manifest: {
      status: 'valid',
      reasons: [],
      location: null,
      counts: { entries: 7, valid: 5, invalid: 1, ignored: 1 },
      problems: [
        {
          index: 6,
          file: 'Pop/Ignoto - Copiato.mp3',
          kind: 'invalid',
          reasons: ['licenza non accettata: cc-by-nc (uso non commerciale)'],
        },
        {
          index: 7,
          file: 'Rock/Assente.mp3',
          kind: 'ignored',
          reasons: [
            'file non trovato nello store: controlla cartelle, maiuscole, spazi ed estensione',
          ],
        },
      ],
    },
    summary: {
      totalTracks: 6,
      declared: 5,
      declaredWithLyrics: 4,
      lyricsFound: 1,
      lyricsMissing: 1,
      lyricsErrors: 1,
      lyricsSkipped: 1,
      lyricsNotShown: 0,
      manifestProblems: 2,
    },
    tracks: TRACKS,
    tracksTruncated: false,
    ...extra,
  };
}

type FetchInit = { schema?: { parse: (value: unknown) => unknown } };

/** Risponde come il vero apiFetch: lo schema del contratto valida i dati di prova. */
function respond(value: unknown) {
  return async (_path: string, init?: FetchInit) =>
    init?.schema ? init.schema.parse(value) : value;
}

function apiError(status: number, body: Record<string, unknown>) {
  return new Error(`apiFetch ${ENDPOINT} failed (${status})`, { cause: body });
}

const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(node: React.ReactNode = <FeaturedRightsDashboard />) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => root.render(node));
  await flush();
  return container;
}

function buttonByText(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    element.textContent?.trim().startsWith(text),
  );
  if (!button) throw new Error(`Pulsante "${text}" non trovato.`);
  return button;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await flush();
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

function tile(container: HTMLElement, label: string) {
  const term = [...container.querySelectorAll('dt')].find((dt) => dt.textContent === label);
  const card = term?.closest('.app-ui-metric');
  if (!card) throw new Error(`Scheda "${label}" non trovata.`);
  return {
    value: card.querySelector('dd')?.textContent,
    detail: card.querySelector('.app-ui-metric-detail')?.textContent,
  };
}

function trackList(container: HTMLElement) {
  return container.querySelector<HTMLUListElement>('ul[aria-label="Brani in evidenza"]');
}

function shownTitles(container: HTMLElement) {
  return [...(trackList(container)?.querySelectorAll('article h3') ?? [])].map(
    (heading) => heading.textContent,
  );
}

function article(container: HTMLElement, title: string) {
  const heading = [...container.querySelectorAll('article h3')].find(
    (element) => element.textContent === title,
  );
  const element = heading?.closest('article');
  if (!element) throw new Error(`Brano "${title}" non trovato.`);
  return element as HTMLElement;
}

function searchInput(container: HTMLElement) {
  const label = [...container.querySelectorAll('label')].find((element) =>
    element.textContent?.startsWith('Cerca per titolo'),
  );
  const input = label ? document.getElementById(label.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error('Campo di ricerca non trovato.');
  return input;
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.apiFetch.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.toast.warning.mockReset();
  mocks.pathname = '/admin/diritti-testi';
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pagina diritti e testi: dati', () => {
  it('caricamento, poi schede di sintesi e stato di diritti.json con le voci con problemi', async () => {
    let release: () => void = () => undefined;
    mocks.apiFetch.mockImplementationOnce(
      (_path: string, init: FetchInit) =>
        new Promise((resolve) => {
          release = () => resolve(init.schema?.parse(report()));
        }),
    );
    const container = await mount();
    expect(container.textContent).toContain('Controllo di diritti.json e dei brani in evidenza…');
    expect(buttonByText(container, 'Aggiorna').getAttribute('aria-disabled')).toBe('true');
    expect(mocks.apiFetch).toHaveBeenCalledWith(ENDPOINT, { schema: AdminFeaturedRightsSchema });

    await act(async () => release());
    await flush();

    expect(container.querySelector('h1')?.textContent).toBe('Diritti e testi');
    expect(container.textContent).toContain('Aggiornato alle 15:30');
    expect(tile(container, 'Brani nello store')).toEqual({
      value: '6',
      detail: 'Come li vede la Home',
    });
    expect(tile(container, 'Dichiarati').value).toBe('5');
    expect(tile(container, 'Con testo attivo').value).toBe('4');
    expect(tile(container, 'Testo trovato')).toEqual({
      value: '1',
      detail: '1 mancante · 1 errore · altro 1 da controllare: aggiorna',
    });
    expect(tile(container, 'Problemi nel manifest')).toEqual({ value: '2', detail: 'su 7 voci' });

    expect(container.textContent).toContain('Valido');
    const problems = container.querySelector('ol[aria-label="Voci scartate o ignorate"]');
    const items = [...(problems?.querySelectorAll(':scope > li') ?? [])];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Voce n. 6');
    expect(items[0]?.textContent).toContain('Scartata');
    expect(items[0]?.querySelector('code')?.textContent).toBe('Pop/Ignoto - Copiato.mp3');
    expect(items[0]?.textContent).toContain(
      'licenza non accettata: cc-by-nc (uso non commerciale)',
    );
    expect(items[1]?.textContent).toContain('Ignorata');
    expect(items[1]?.textContent).toContain('file non trovato nello store');
    // Manifest valido: la guida è chiusa (si apre a mano).
    expect(container.querySelector('details')?.open).toBe(false);
  });

  it('manifest non valido: motivo, riga e colonna, guida aperta con l’esempio "testo": true', async () => {
    mocks.apiFetch.mockImplementation(
      respond(
        report({
          manifest: {
            status: 'invalid',
            reasons: [
              'JSON non valido alla riga 3, colonna 5: controlla virgole, virgolette e parentesi',
            ],
            location: { line: 3, column: 5 },
            counts: { entries: 0, valid: 0, invalid: 0, ignored: 0 },
            problems: [],
          },
          summary: { ...report().summary, declared: 0, declaredWithLyrics: 0, manifestProblems: 0 },
          tracks: TRACKS.map((track) => ({
            ...track,
            declared: false,
            licenza: null,
            titolare: null,
            testo: false,
            lyrics: { status: 'not_checked' as const },
          })),
        }),
      ),
    );
    const container = await mount();
    expect(container.textContent).toContain('Non valido');
    expect(container.textContent).toContain('JSON non valido alla riga 3, colonna 5');
    expect(container.textContent).toContain('Errore alla riga 3, colonna 5.');
    expect(tile(container, 'Problemi nel manifest')).toEqual({
      value: 'Non valido',
      detail: 'Nessun brano ricercabile',
    });
    const guide = container.querySelector('details');
    expect(guide?.open).toBe(true);
    expect(guide?.querySelector('pre')?.textContent).toContain('"testo": true');
    expect(guide?.textContent).toContain('spesso non copre il testo');
    expect(guide?.textContent).toContain('.lrc');
    expect(guide?.textContent).toContain('siti che copiano Spotify');
    expect(article(container, 'Autrice — Città').textContent).toContain(
      'Non ricercabile: diritti.json non è valido',
    );
  });

  it('spiega ogni brano: ricercabile, fonte e righe del testo, file da caricare, testo spento', async () => {
    mocks.apiFetch.mockImplementation(respond(report()));
    const container = await mount();
    const found = article(container, 'Autrice — Città');
    expect(found.textContent).toContain('Ricercabile');
    expect(found.textContent).toContain('Testo .lrc · 24 righe');
    expect(found.textContent).toContain('dal file .lrc accanto, sincronizzato, 24 righe');
    expect(found.querySelector('code')?.textContent).toBe('Cantautori/Autrice - Città.mp3');

    const missing = article(container, 'Autrice — Ballata');
    expect(missing.textContent).toContain('Testo non trovato');
    expect(missing.textContent).toContain('“Cantautori/Autrice - Ballata.lrc”');

    expect(article(container, 'Band — Inno').textContent).toContain('Errore di lettura');
    expect(article(container, 'Band — Strumentale').textContent).toContain('Testo spento');
    expect(article(container, 'Band — Nuovo').textContent).toContain('Da controllare');
    const undeclared = article(container, 'Ignoto — Copiato');
    expect(undeclared.textContent).toContain('Non dichiarato');
    expect(undeclared.textContent).toContain('C’è un file di testo accanto');
  });
});

describe('pagina diritti e testi: filtri, ricerca e copia', () => {
  it('filtri con conteggi e aria-pressed', async () => {
    mocks.apiFetch.mockImplementation(respond(report()));
    const container = await mount();
    expect(shownTitles(container)).toHaveLength(6);
    expect(buttonByText(container, 'Tutti').getAttribute('aria-pressed')).toBe('true');

    const cases: Array<[string, string[]]> = [
      [
        'Dichiarati',
        [
          'Autrice — Città',
          'Autrice — Ballata',
          'Band — Inno',
          'Band — Strumentale',
          'Band — Nuovo',
        ],
      ],
      ['Non dichiarati', ['Ignoto — Copiato']],
      ['Testo attivo', ['Autrice — Città', 'Autrice — Ballata', 'Band — Inno', 'Band — Nuovo']],
      ['Testo trovato', ['Autrice — Città']],
      ['Testo mancante', ['Autrice — Ballata', 'Band — Inno']],
    ];
    for (const [label, titles] of cases) {
      const button = buttonByText(container, label);
      expect(button.textContent).toContain(String(titles.length));
      await click(button);
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(buttonByText(container, 'Tutti').getAttribute('aria-pressed')).toBe('false');
      expect(shownTitles(container), label).toEqual(titles);
    }
  });

  it('ricerca per titolo (senza accenti), artista o percorso; nessun risultato', async () => {
    mocks.apiFetch.mockImplementation(respond(report()));
    const container = await mount();
    const input = searchInput(container);
    await type(input, 'citta');
    expect(shownTitles(container)).toEqual(['Autrice — Città']);
    expect(container.textContent).toContain('1 brano su 6');
    await type(input, 'band');
    expect(shownTitles(container)).toEqual(['Band — Inno', 'Band — Strumentale', 'Band — Nuovo']);
    await type(input, 'serie/');
    expect(shownTitles(container)).toEqual(['Band — Nuovo']);
    await type(input, 'inno rock');
    expect(shownTitles(container)).toEqual(['Band — Inno']);
    await type(input, 'nessuno così');
    expect(trackList(container)).toBeNull();
    expect(container.textContent).toContain('Nessun brano corrisponde');
  });

  it('"Copia percorso" copia il pathname esatto e lo conferma; errore se gli appunti falliscono', async () => {
    mocks.apiFetch.mockImplementation(respond(report()));
    const container = await mount();
    const copy = article(container, 'Autrice — Città').querySelector<HTMLButtonElement>(
      'button[aria-label="Copia percorso di Autrice — Città"]',
    );
    expect(copy?.textContent).toContain('Copia percorso');
    if (!copy) throw new Error('Pulsante di copia non trovato.');
    await click(copy);
    expect(writeText).toHaveBeenCalledWith('Cantautori/Autrice - Città.mp3');
    expect(mocks.toast.success).toHaveBeenCalledWith('Percorso copiato.');

    writeText.mockRejectedValueOnce(new Error('negato'));
    await click(copy);
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Copia non riuscita: seleziona il percorso e copialo a mano.',
    );
  });

  it('nessuna scorciatoia per dichiarare: niente "dichiara tutti", "genera" o voci pronte', async () => {
    mocks.apiFetch.mockImplementation(respond(report()));
    const container = await mount();
    const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent);
    for (const text of buttons) {
      expect(text).not.toMatch(/dichiara tutt|genera|aggiungi a diritti|copia voce|copia json/i);
    }
    // L'unico JSON mostrato è l'esempio fisso della guida, non voci costruite dai brani dello store.
    expect(container.querySelectorAll('pre')).toHaveLength(1);
    expect(container.querySelector('pre')?.textContent).not.toContain('Ignoto - Copiato');
  });

  it('"Mostra altri" quando i brani sono più di 50', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      row(`Serie/Band - Brano ${String(index).padStart(2, '0')}.mp3`),
    );
    mocks.apiFetch.mockImplementation(
      respond(report({ tracks: many, summary: { ...report().summary, totalTracks: 60 } })),
    );
    const container = await mount();
    expect(shownTitles(container)).toHaveLength(50);
    await click(buttonByText(container, 'Mostra altri 10'));
    expect(shownTitles(container)).toHaveLength(60);
  });
});

describe('pagina diritti e testi: stati', () => {
  it('errore con il messaggio del server e "Riprova"', async () => {
    mocks.apiFetch.mockRejectedValueOnce(apiError(403, { error: 'forbidden' }));
    const container = await mount();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Non riesco a mostrare la diagnosi.');
    expect(alert?.textContent).toContain('Serve un account amministratore con email verificata.');

    mocks.apiFetch.mockImplementation(respond(report()));
    await click(buttonByText(container, 'Riprova'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(shownTitles(container)).toHaveLength(6);
  });

  it('risposta fuori contratto → messaggio di formato', async () => {
    mocks.apiFetch.mockImplementation(respond({ ...report(), extra: true }));
    const container = await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'La risposta del server non è nel formato atteso.',
    );
  });

  it('store non disponibile: avviso e stato vuoto con il motivo', async () => {
    const reason =
      'Vercel Blob non è configurato (manca BLOB_READ_WRITE_TOKEN): nessun brano in evidenza.';
    mocks.apiFetch.mockImplementation(
      respond(
        report({
          store: { status: 'unavailable', listedAt: null, reason },
          manifest: {
            status: 'unavailable',
            reasons: [reason],
            location: null,
            counts: { entries: 0, valid: 0, invalid: 0, ignored: 0 },
            problems: [],
          },
          summary: {
            totalTracks: 0,
            declared: 0,
            declaredWithLyrics: 0,
            lyricsFound: 0,
            lyricsMissing: 0,
            lyricsErrors: 0,
            lyricsSkipped: 0,
            lyricsNotShown: 0,
            manifestProblems: 0,
          },
          tracks: [],
        }),
      ),
    );
    const container = await mount();
    expect(container.textContent).toContain('Store non disponibile');
    expect(container.textContent).toContain('Non leggibile');
    expect(container.textContent).toContain('manca BLOB_READ_WRITE_TOKEN');
    // Il motivo non si ripete in un avviso in cima: c'è già nel pannello e nello stato vuoto.
    expect(container.textContent).not.toContain('Elenco dello store incompleto');
  });

  it('elenco dello store incompleto: avviso e scheda "Elenco incompleto"', async () => {
    const reason =
      'Elenco dello store incompleto (errore, tempo scaduto o troppi file): alcuni brani potrebbero mancare.';
    mocks.apiFetch.mockImplementation(
      respond(report({ store: { status: 'partial', listedAt: NOW.toISOString(), reason } })),
    );
    const container = await mount();
    expect(container.textContent).toContain(reason);
    expect(tile(container, 'Brani nello store').detail).toBe('Elenco incompleto');
    expect(shownTitles(container)).toHaveLength(6);
  });

  it('"Aggiorna" rilegge e lo annuncia; un errore lascia i dati precedenti', async () => {
    mocks.apiFetch.mockImplementation(respond(report()));
    const container = await mount();
    await click(buttonByText(container, 'Aggiorna'));
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('output')?.textContent).toBe('Dati aggiornati alle 15:30.');

    mocks.apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await click(buttonByText(container, 'Aggiorna'));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Aggiornamento non riuscito.');
    expect(alert?.textContent).toContain('Connessione non riuscita');
    expect(shownTitles(container)).toHaveLength(6);
  });
});

describe('«Aggiorna ora» (brani in evidenza subito ovunque)', () => {
  const REFRESH = '/api/admin/featured-rights/refresh';
  const refreshed = {
    generation: 3,
    version: '0123456789abcdef',
    updatedAt: '2026-11-14T14:30:00.000Z',
    stale: false,
  };

  function routed(onRefresh: () => unknown) {
    return async (path: string, init?: FetchInit & { method?: string }) => {
      if (path === REFRESH) {
        const value = await onRefresh();
        return init?.schema ? init.schema.parse(value) : value;
      }
      return respond(report())(path, init);
    };
  }

  it('dopo «Aggiorna»: POST al server, avviso di conferma e diagnosi riletta', async () => {
    mocks.apiFetch.mockImplementation(routed(() => refreshed));
    const container = await mount();
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    // Dopo il pulsante «Aggiorna» della diagnosi.
    expect(buttons.indexOf('Aggiorna ora')).toBeGreaterThan(buttons.indexOf('Aggiorna'));

    await click(buttonByText(container, 'Aggiorna ora'));
    await flush();
    const refreshCall = mocks.apiFetch.mock.calls.find(([path]) => path === REFRESH);
    expect(refreshCall?.[1]).toMatchObject({ method: 'POST' });
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Brani in evidenza aggiornati: compariranno ovunque entro un minuto',
    );
    // La diagnosi si rilegge subito (2 letture: apertura + dopo l'aggiornamento).
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === ENDPOINT)).toHaveLength(2);
  });

  it('lo store Blob non ha risposto (`stale`): avviso, mai la conferma', async () => {
    mocks.apiFetch.mockImplementation(routed(() => ({ ...refreshed, stale: true })));
    const container = await mount();
    await click(buttonByText(container, 'Aggiorna ora'));
    await flush();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'Lo store Blob non ha risposto: i brani in evidenza si aggiorneranno appena torna disponibile. Riprova tra poco.',
    );
    // La diagnosi si rilegge comunque.
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === ENDPOINT)).toHaveLength(2);
  });

  it('se finisce mentre la diagnosi si sta ancora caricando, la diagnosi si rilegge comunque', async () => {
    let releaseFirst: (value: unknown) => void = () => undefined;
    let diagnosis = 0;
    mocks.apiFetch.mockImplementation(async (path: string, init?: FetchInit) => {
      const parse = (value: unknown) => (init?.schema ? init.schema.parse(value) : value);
      if (path === REFRESH) return parse(refreshed);
      diagnosis += 1;
      if (diagnosis === 1) {
        // La prima lettura (partita prima dello svuotamento delle cache) è lenta.
        return parse(
          await new Promise((resolve) => {
            releaseFirst = resolve;
          }),
        );
      }
      return parse(report({ generatedAt: '2026-11-14T14:35:00.000Z' }));
    });
    const container = await mount();
    await click(buttonByText(container, 'Aggiorna ora'));
    await flush();
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === ENDPOINT)).toHaveLength(2);
    // La lettura vecchia arriva dopo: scartata, resta quella nuova.
    await act(async () => releaseFirst(report({ generatedAt: '2026-11-14T14:00:00.000Z' })));
    await flush();
    expect(container.querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-11-14T14:35:00.000Z',
    );
  });

  it('limite raggiunto o errore: avviso con il messaggio del server, nessuna conferma', async () => {
    mocks.apiFetch.mockImplementation(
      routed(() => {
        throw new Error(`apiFetch ${REFRESH} failed (429)`, {
          cause: {
            error: 'rate_limited',
            message:
              'Hai già aggiornato i brani in evidenza più volte di recente. Riprova tra 5 minuti.',
          },
        });
      }),
    );
    const container = await mount();
    await click(buttonByText(container, 'Aggiorna ora'));
    await flush();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Hai già aggiornato i brani in evidenza più volte di recente. Riprova tra 5 minuti.',
    );
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === ENDPOINT)).toHaveLength(1);
  });

  it('mentre l’aggiornamento è in corso il pulsante è occupato e non parte due volte', async () => {
    let release: () => void = () => undefined;
    mocks.apiFetch.mockImplementation(
      routed(
        () =>
          new Promise((resolve) => {
            release = () => resolve(refreshed);
          }),
      ),
    );
    const container = await mount();
    const button = buttonByText(container, 'Aggiorna ora');
    await click(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await click(button);
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === REFRESH)).toHaveLength(1);
    await act(async () => release());
    await flush();
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
  });
});

describe('raggiungibilità', () => {
  it('menu amministrazione: "Diritti e testi" subito dopo "Diritti musicali", attiva qui', async () => {
    const container = await mount(<AdminNav />);
    const links = [...container.querySelectorAll<HTMLAnchorElement>('nav a')];
    const index = links.findIndex((link) => link.getAttribute('href') === '/admin/diritti-testi');
    expect(index).toBeGreaterThan(0);
    expect(links[index - 1]?.getAttribute('href')).toBe('/admin/music-rights');
    expect(links[index]?.textContent).toBe('Diritti e testi');
    expect(links[index]?.getAttribute('aria-current')).toBe('page');
    expect(links[index]?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('la panoramica /admin ha la scheda "Diritti e testi" con il collegamento', async () => {
    mocks.pathname = '/admin';
    const container = await mount(<AdminPage />);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/admin/diritti-testi"]');
    expect(link?.textContent).toContain('Apri diritti e testi');
    const card = link?.closest('article');
    expect(card?.querySelector('h2')?.textContent).toBe('Diritti e testi');
    expect(card?.textContent).toContain('La diagnosi non mostra il testo');
    expect(card?.textContent).toContain('puoi trascriverlo con l’IA');
  });
});

describe('pagina diritti e testi: spiegazioni dei casi limite', () => {
  it('elenco dello store fallito senza brani: nessun invito a caricare i file', async () => {
    const reason =
      'Elenco dello store incompleto (errore, tempo scaduto o troppi file): alcuni brani potrebbero mancare.';
    mocks.apiFetch.mockImplementation(
      respond(
        report({
          store: { status: 'partial', listedAt: NOW.toISOString(), reason },
          summary: { ...report().summary, totalTracks: 0, declared: 0, declaredWithLyrics: 0 },
          tracks: [],
        }),
      ),
    );
    const container = await mount();
    expect(container.textContent).toContain('Elenco dello store non riuscito');
    expect(container.textContent).toContain('Riprova tra qualche secondo con «Aggiorna».');
    expect(container.textContent).not.toContain('Carica i file audio');
    expect(container.textContent).not.toContain('Nessun brano in evidenza nello store');
  });

  it('elenco completo e vuoto: invito a caricare i file', async () => {
    mocks.apiFetch.mockImplementation(respond(report({ tracks: [] })));
    const container = await mount();
    expect(container.textContent).toContain('Nessun brano in evidenza nello store');
    expect(container.textContent).toContain('Carica i file audio');
  });

  it('testo spento da un doppione: indica la voce che lo spegne, non "aggiungi testo: true"', async () => {
    mocks.apiFetch.mockImplementation(
      respond(
        report({
          tracks: [
            row('Rock/A - B.mp3', {
              ...declared,
              testoOffBy: 2,
              sidecars: { lrc: true, txt: false },
            }),
          ],
        }),
      ),
    );
    const container = await mount();
    const card = article(container, 'A — B');
    expect(card.textContent).toContain('Testo spento');
    expect(card.textContent).toContain('la voce n. 2 non ha "testo": true');
    expect(card.textContent).not.toContain('aggiungilo solo se');
  });

  it('lettura del file accanto fallita ≠ file inutilizzabile', async () => {
    const lyricsOn = { ...declared, testo: true, sidecars: { lrc: true, txt: false } };
    mocks.apiFetch.mockImplementation(
      respond(
        report({
          tracks: [
            row('Rock/A - Rete.mp3', {
              ...lyricsOn,
              lyrics: { status: 'embedded', kind: 'plain', lineCount: 3, sidecarError: true },
            }),
            row('Rock/A - Rotto.mp3', {
              ...lyricsOn,
              lyrics: { status: 'embedded', kind: 'plain', lineCount: 3 },
            }),
            row('Rock/A - Errore.mp3', { ...lyricsOn, lyrics: { status: 'error' } }),
          ],
        }),
      ),
    );
    const container = await mount();
    const network = article(container, 'A — Rete').textContent ?? '';
    expect(network).toContain('La lettura del file di testo accanto non è riuscita');
    expect(network).not.toContain('non è usabile');
    expect(article(container, 'A — Rotto').textContent).toContain(
      'Il file di testo accanto non è usabile',
    );
    expect(article(container, 'A — Errore').textContent).toContain('«Aggiorna» la riprova');
  });

  it('brani con testo attivo oltre quelli mostrati: detto nella scheda "Testo trovato"', async () => {
    mocks.apiFetch.mockImplementation(
      respond(
        report({
          summary: { ...report().summary, lyricsSkipped: 0, lyricsNotShown: 2 },
          tracksTruncated: true,
        }),
      ),
    );
    const container = await mount();
    expect(tile(container, 'Testo trovato').detail).toBe(
      '1 mancante · 1 errore · 2 oltre i brani mostrati (non controllati)',
    );
  });
});
