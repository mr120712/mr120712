// @polsia:user-owned — «Carica su audio.com» lato client: il pannello compare nella pagina admin solo
// con l'account collegato; titolo proposto dal nome del file; senza la conferma dei diritti (o senza
// un file accettato) il modulo non parte; con tutto in regola «Caricamento del file…» con la
// percentuale (staging su Vercel Blob), «Invio ad audio.com…», toast di successo e link alla pagina
// del brano; errori dei campi dal server sotto i campi, gli altri in un toast. Più le funzioni pure
// del client (MIME, percorso di staging, titolo e nome del file).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  upload: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@vercel/blob/client', () => ({ upload: mocks.upload }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import { AudioComAdmin } from '@/components/custom/music/audiocom-admin';
import { AudioComUploadAdmin } from '@/components/custom/music/audiocom-upload-admin';
import { AUDIOCOM_UPLOAD_MESSAGES } from '@/lib/contracts/audiocom-upload';
import {
  audioComOriginalName,
  audioComStagingPathname,
  audioComTitleFromFileName,
  audioComUploadMime,
} from '@/lib/music/audiocom-upload.client';

const COLLECTIONS = '/api/admin/audiocom/collections';
const UPLOADS = '/api/admin/audiocom/uploads';
const BLOB_URL =
  'https://storeabc123.public.blob.vercel-storage.com/audiocom-staging/il-mio-brano-AbC123.mp3';
const PAGE_URL = 'https://audio.com/solco/audio/il-mio-brano';

const RESPONSE = {
  audio: {
    id: '164620711711840702',
    title: 'Il mio brano',
    pageUrl: PAGE_URL,
    license: 'cc-by',
    isListed: false,
  },
  collectionAdded: true,
};

const COLLECTIONS_BODY = {
  status: 'ok',
  collections: [
    {
      id: '555',
      title: 'Primo album',
      type: 'album',
      itemsCount: 2,
      listed: true,
      imageUrl: null,
      featured: false,
    },
  ],
  featuredIds: [],
};

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  await flush();
  return container;
}

function audioFile(name = 'Il_mio brano.mp3', type = 'audio/mpeg', size = 8) {
  return new File([new Uint8Array(size)], name, { type });
}

async function chooseFile(container: HTMLElement, file: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('selettore del file mancante');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

async function choose(container: HTMLElement, name: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
  if (!select) throw new Error(`select ${name} mancante`);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

/** Il controllo collegato all'etichetta che contiene `text`. */
function controlByLabel(container: HTMLElement, text: string): HTMLElement {
  const label = [...container.querySelectorAll('label')].find((element) =>
    element.textContent?.includes(text),
  );
  const control = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!control) throw new Error(`controllo «${text}» mancante`);
  return control;
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error('elemento mancante');
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
}

function submitButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('button[type="submit"]');
}

function uploadCalls() {
  return mocks.apiFetch.mock.calls.filter(([url]) => url === UPLOADS);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === COLLECTIONS) return COLLECTIONS_BODY;
    return RESPONSE;
  });
  mocks.upload.mockResolvedValue({ url: BLOB_URL, pathname: 'audiocom-staging/x.mp3' });
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('funzioni del client', () => {
  it('MIME per estensione o tipo dichiarato; solo i formati di audio.com', () => {
    expect(audioComUploadMime({ name: 'a.MP3', type: '' })).toBe('audio/mpeg');
    expect(audioComUploadMime({ name: 'a.m4a', type: 'audio/x-m4a' })).toBe('audio/mp4');
    expect(audioComUploadMime({ name: 'a.wav', type: 'audio/x-wav' })).toBe('audio/wav');
    expect(audioComUploadMime({ name: 'senza-estensione', type: 'audio/x-flac' })).toBe(
      'audio/flac',
    );
    expect(audioComUploadMime({ name: 'a.webm', type: 'audio/webm' })).toBeNull();
    expect(audioComUploadMime({ name: 'a.pdf', type: 'application/pdf' })).toBeNull();
  });

  it('percorso di staging, titolo proposto e nome originale', () => {
    expect(audioComStagingPathname('Il_mio brano (demo).wav', 'audio/wav')).toBe(
      'audiocom-staging/il-mio-brano-demo.wav',
    );
    expect(audioComStagingPathname('Città.mp3', 'audio/mpeg')).toBe('audiocom-staging/citta.mp3');
    expect(audioComStagingPathname('日本.flac', 'audio/flac')).toBe('audiocom-staging/brano.flac');
    expect(audioComTitleFromFileName('Il_mio  brano.final.mp3')).toBe('Il mio brano.final');
    const long = `${'x'.repeat(300)}.mp3`;
    expect(audioComOriginalName(long)).toHaveLength(255);
    expect(audioComOriginalName(long).endsWith('.mp3')).toBe(true);
  });
});

describe('pagina admin', () => {
  const status = {
    configured: true,
    connected: true,
    needsReconnect: false,
    clientRegistered: true,
    accountName: 'Solco Official',
    connectedAt: '2026-11-14T09:00:00.000Z',
    lastError: null,
    lastErrorAt: null,
    redirectUri: 'https://solco.test/api/admin/audiocom/callback',
  };

  it('il pannello compare solo con l’account collegato', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) =>
      url === COLLECTIONS ? COLLECTIONS_BODY : status,
    );
    const connected = await mount(<AudioComAdmin />);
    expect(connected.querySelector('input[type="file"]')).not.toBeNull();
    expect(connected.textContent).toContain('Carica su audio.com');

    mocks.apiFetch.mockImplementation(async () => ({ ...status, connected: false }));
    const disconnected = await mount(<AudioComAdmin />);
    expect(disconnected.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('«Carica su audio.com»', () => {
  it('senza la conferma dei diritti il modulo non parte', async () => {
    const container = await mount(<AudioComUploadAdmin />);
    await chooseFile(container, audioFile());
    expect(container.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe(
      'Il mio brano',
    );

    await click(submitButton(container));
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(uploadCalls()).toHaveLength(0);
    expect(container.textContent).toContain(AUDIOCOM_UPLOAD_MESSAGES.rights);
    const rights = controlByLabel(container, 'Confermo che è musica mia') as HTMLInputElement;
    expect(rights.type).toBe('checkbox');
    expect(rights.required).toBe(true);
    expect(rights.getAttribute('aria-invalid')).toBe('true');
    // Il messaggio è collegato alla casella (letto dai lettori di schermo).
    const described = (rights.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain(AUDIOCOM_UPLOAD_MESSAGES.rights);
  });

  it('senza un file accettato il modulo non parte (errore sotto il campo)', async () => {
    const container = await mount(<AudioComUploadAdmin />);
    await click(controlByLabel(container, 'Confermo che è musica mia'));
    await click(submitButton(container));
    expect(container.textContent).toContain(AUDIOCOM_UPLOAD_MESSAGES.file);

    await chooseFile(container, audioFile('video.webm', 'video/webm'));
    expect(container.textContent).toContain(AUDIOCOM_UPLOAD_MESSAGES.fileFormat);
    expect(container.querySelector('input[type="file"]')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
    await click(submitButton(container));
    expect(container.textContent).toContain(AUDIOCOM_UPLOAD_MESSAGES.fileFormat);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(uploadCalls()).toHaveLength(0);
  });

  it('tutto in regola: staging con percentuale, invio ad audio.com, toast e link alla pagina', async () => {
    let finishStaging: (value: unknown) => void = () => undefined;
    mocks.upload.mockImplementation(
      (
        _pathname: string,
        _file: File,
        options: { onUploadProgress?: (event: { percentage: number }) => void },
      ) => {
        options.onUploadProgress?.({ percentage: 50 });
        return new Promise((resolve) => {
          finishStaging = resolve;
        });
      },
    );
    let finishSend: (value: unknown) => void = () => undefined;
    mocks.apiFetch.mockImplementation((url: string) =>
      url === COLLECTIONS
        ? Promise.resolve(COLLECTIONS_BODY)
        : new Promise((resolve) => {
            finishSend = resolve;
          }),
    );

    const container = await mount(<AudioComUploadAdmin />);
    const file = audioFile();
    await chooseFile(container, file);
    await choose(container, 'license', 'cc-by');
    await choose(container, 'collectionId', '555');
    expect(container.textContent).toContain('In Solco si ascolta nel player di Solco');
    await click(controlByLabel(container, 'Confermo che è musica mia'));
    await click(submitButton(container));

    // 1. Staging su Vercel Blob con la percentuale.
    expect(container.textContent).toContain('Caricamento del file…');
    expect(container.textContent).toContain('50%');
    expect(mocks.upload).toHaveBeenCalledWith(
      'audiocom-staging/il-mio-brano.mp3',
      file,
      expect.objectContaining({
        access: 'public',
        handleUploadUrl: '/api/admin/audiocom/uploads/blob',
        contentType: 'audio/mpeg',
        multipart: false,
      }),
    );
    expect(uploadCalls()).toHaveLength(0);

    // 2. Invio ad audio.com dal server.
    await act(async () => finishStaging({ url: BLOB_URL, pathname: 'audiocom-staging/x.mp3' }));
    await flush();
    expect(container.textContent).toContain('Invio ad audio.com…');
    const [call] = uploadCalls();
    expect((call?.[1] as { method: string }).method).toBe('POST');
    expect(JSON.parse((call?.[1] as { body: string }).body)).toEqual({
      blobUrl: BLOB_URL,
      name: 'Il_mio brano.mp3',
      size: 8,
      mime: 'audio/mpeg',
      title: 'Il mio brano',
      license: 'cc-by',
      category: 'music',
      isListed: false,
      isDownloadable: false,
      collectionId: '555',
      rightsConfirmed: true,
    });

    // 3. Esito: toast col link e link nel pannello; il modulo torna pronto.
    await act(async () => finishSend(RESPONSE));
    await flush();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Brano caricato su audio.com.',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Apri su audio.com' }),
      }),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
    const link = container.querySelector<HTMLAnchorElement>(`a[href="${PAGE_URL}"]`);
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noopener');
    expect(container.textContent).not.toContain('Invio ad audio.com…');
    expect(container.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe('');
    expect(
      (controlByLabel(container, 'Confermo che è musica mia') as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('errori dei campi dal server: sotto il campo, nessun toast', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === COLLECTIONS) return COLLECTIONS_BODY;
      throw new Error(`apiFetch ${UPLOADS} failed (400)`, {
        cause: { errors: { title: 'audio.com non accetta questo titolo.' } },
      });
    });
    const container = await mount(<AudioComUploadAdmin />);
    await chooseFile(container, audioFile());
    await click(controlByLabel(container, 'Confermo che è musica mia'));
    await click(submitButton(container));
    expect(container.textContent).toContain('audio.com non accetta questo titolo.');
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('errore del server senza campi: il messaggio in un toast', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === COLLECTIONS) return COLLECTIONS_BODY;
      throw new Error(`apiFetch ${UPLOADS} failed (503)`, {
        cause: {
          error: 'audiocom_unavailable',
          message: 'audio.com non risponde in questo momento: riprova tra poco.',
        },
      });
    });
    const container = await mount(<AudioComUploadAdmin />);
    await chooseFile(container, audioFile());
    await click(controlByLabel(container, 'Confermo che è musica mia'));
    await click(submitButton(container));
    expect(mocks.toastError).toHaveBeenCalledWith(
      'audio.com non risponde in questo momento: riprova tra poco.',
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('caricamento su Vercel Blob non autorizzato: toast chiaro, niente invio', async () => {
    mocks.upload.mockRejectedValue(new Error('Vercel Blob: Failed to  retrieve the client token'));
    const container = await mount(<AudioComUploadAdmin />);
    await chooseFile(container, audioFile());
    await click(controlByLabel(container, 'Confermo che è musica mia'));
    await click(submitButton(container));
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining('Il caricamento non è stato autorizzato'),
    );
    expect(uploadCalls()).toHaveLength(0);
  });
});
