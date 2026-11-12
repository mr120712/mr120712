// @polsia:user-owned — "Scarica per offline" (UI parte 2): la playlist scarica SOLO gli elementi
// consentiti e segnala gli online-only; avanzamento; stati login/limite/dimensione; un brano Audius
// scaricato mostra l'avviso OML. Store e fetch sono finti: nessun download vero, nessun IndexedDB.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicCollectionItem } from '@/lib/contracts/music';
import type { OfflineDownloadMeta } from '@/lib/contracts/offline';

const mocks = vi.hoisted(() => ({
  addDownloaded: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  fetch: vi.fn(),
}));
vi.mock('@/lib/local-music', () => ({ addDownloadedTrack: mocks.addDownloaded }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { DownloadedTrackCredit } from '@/components/custom/music/downloaded-track-credit';
import {
  collectionDownloadPlan,
  downloadOne,
  type OfflineDownloadTarget,
  offlineBatchSummary,
  runOfflineDownloadBatch,
} from '@/components/custom/music/offline-download';
import { OfflineDownloadButton } from '@/components/custom/music/offline-download-button';

const OML_URL = 'https://openaudiofoundation.org/open-music-license.pdf';

const audiusMeta: OfflineDownloadMeta = {
  source: 'audius-download',
  downloadKey: 'audius:track-71',
  title: 'Brano OML',
  artist: 'Artista',
  album: null,
  durationSeconds: 180,
  mimeType: 'audio/mpeg',
  attribution: {
    sourceName: 'Audius',
    sourceUrl: 'https://audius.co/artista/brano-oml',
    licenseName: 'Audius Open Music License',
    licenseUrl: OML_URL,
    creditLine: '© 2025 Artista',
  },
};

function okResponse(meta: OfflineDownloadMeta, bytes = new Uint8Array([1, 2, 3, 4])) {
  const header = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': meta.mimeType, 'x-solco-download': header },
  });
}

function errResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const audiusTarget: OfflineDownloadTarget = {
  id: 'item-audius',
  title: 'Brano OML',
  endpoint: { kind: 'audius', trackId: 'track-71' },
};

function collectionItem(overrides: Partial<MusicCollectionItem>): MusicCollectionItem {
  return {
    id: 'x',
    source: 'audius',
    sourceId: 'track-71',
    title: 'Brano',
    creatorName: 'Artista',
    artworkUrl: 'https://audius.co/cover.jpg',
    sourceUrl: 'https://audius.co/artista/brano',
    artistUrl: 'https://audius.co/artista',
    durationSeconds: 180,
    createdAt: '2026-11-10T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

describe('piano di download di una raccolta', () => {
  it('rende scaricabili solo gli Audius completi e lascia online YouTube, i brani importati e gli Audius incompleti', () => {
    const plan = collectionDownloadPlan([
      collectionItem({ id: 'a', source: 'audius', sourceId: 'track-71' }),
      collectionItem({ id: 'y', source: 'youtube', sourceId: 'dQw4w9WgXcQ' }),
      collectionItem({ id: 's', source: 'song', sourceId: 'a'.repeat(32) }),
      collectionItem({ id: 'inc', source: 'audius', sourceId: 'track-72', sourceUrl: null }),
    ]);
    expect(plan.downloadable.map((target) => target.id)).toEqual(['a']);
    expect(plan.downloadable[0]?.endpoint).toEqual({ kind: 'audius', trackId: 'track-71' });
    // Un brano importato (source 'song') con titolo+artista si prova a risolvere su Audius.
    expect(plan.resolvable).toEqual([{ id: 's', title: 'Brano', artist: 'Artista' }]);
    const onlineIds = plan.onlineOnly.map((item) => item.id);
    expect(onlineIds).toEqual(['y', 'inc']);
    expect(plan.onlineOnly[0]?.reason).toContain('YouTube');
  });
});

describe('runner: scarica i soli elementi consentiti', () => {
  it('salva il brano con i metadati dell’header e segnala l’avanzamento n di m', async () => {
    mocks.addDownloaded.mockResolvedValue({ ok: true, track: { id: 'local-1' } });
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      okResponse(audiusMeta),
    );
    const progress: Array<{ processed: number; total: number }> = [];
    const second: OfflineDownloadTarget = {
      id: 'item-2',
      title: 'Secondo',
      endpoint: { kind: 'podcast', podcastId: '42', episodeKey: 'ep-1' },
    };
    const result = await runOfflineDownloadBatch([audiusTarget, second], {
      fetcher,
      addDownloaded: mocks.addDownloaded,
      onProgress: ({ processed, total }) => progress.push({ processed, total }),
    });

    expect(progress).toEqual([
      { processed: 1, total: 2 },
      { processed: 2, total: 2 },
    ]);
    expect(result.saved.map((target) => target.id)).toEqual(['item-audius', 'item-2']);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/music/audius/tracks/track-71/download');
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/music/podcasts/42/episodes/ep-1/download');
    // L'attribuzione con accenti/© viaggia dall'header allo store senza corrompersi.
    expect(mocks.addDownloaded).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadKey: 'audius:track-71',
        source: 'audius-download',
        title: 'Brano OML',
        attribution: expect.objectContaining({
          creditLine: '© 2025 Artista',
          licenseName: 'Audius Open Music License',
        }),
      }),
    );
    expect(offlineBatchSummary(result).tone).toBe('success');
  });

  it('un brano già nella libreria conta come già presente, non come nuovo', async () => {
    mocks.addDownloaded.mockResolvedValue({ ok: false, reason: 'duplicate' });
    const result = await runOfflineDownloadBatch([audiusTarget], {
      fetcher: async () => okResponse(audiusMeta),
      addDownloaded: mocks.addDownloaded,
    });
    expect(result.already.map((target) => target.id)).toEqual(['item-audius']);
    expect(result.saved).toHaveLength(0);
  });

  it('senza login si ferma subito e chiede di accedere', async () => {
    const fetcher = vi.fn(async () =>
      errResponse(401, { error: 'unauthorized', message: 'Accesso richiesto.' }),
    );
    const result = await runOfflineDownloadBatch([audiusTarget, audiusTarget], {
      fetcher,
      addDownloaded: mocks.addDownloaded,
    });
    expect(result.stopped).toBe('login-required');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.addDownloaded).not.toHaveBeenCalled();
    expect(offlineBatchSummary(result).message).toContain('accedere');
  });

  it('oltre il limite giornaliero riporta il messaggio del server e si ferma', async () => {
    const result = await runOfflineDownloadBatch([audiusTarget, audiusTarget], {
      fetcher: async () =>
        errResponse(429, {
          error: 'rate_limited',
          message: 'Hai raggiunto il limite di download di oggi.',
          retryAfterSeconds: 3600,
        }),
      addDownloaded: mocks.addDownloaded,
    });
    expect(result.stopped).toBe('limit-reached');
    expect(result.stopMessage).toContain('limite di download di oggi');
  });

  it('un brano oltre i 50 MB non ferma il lotto: resta tra i non riusciti', async () => {
    const result = await runOfflineDownloadBatch([audiusTarget], {
      fetcher: async () => errResponse(413, { error: 'too_large', message: '> 50 MB' }),
      addDownloaded: mocks.addDownloaded,
    });
    expect(result.stopped).toBeNull();
    expect(result.failed[0]?.message).toContain('50 MB');
  });

  it('un Audius che l’artista non ha reso scaricabile torna tra gli online-only', async () => {
    const outcome = await downloadOne(audiusTarget, {
      fetcher: async () =>
        errResponse(403, {
          error: 'not_downloadable',
          message: 'L’artista non ha reso scaricabile questo brano.',
        }),
      addDownloaded: mocks.addDownloaded,
    });
    expect(outcome.status).toBe('online-only');
    if (outcome.status === 'online-only') expect(outcome.reason).toContain('scaricabile');
  });
});

const roots: Array<ReturnType<typeof createRoot>> = [];

async function render(node: React.ReactNode) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function findButton(container: HTMLElement, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text),
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.addDownloaded.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.fetch.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OfflineDownloadButton', () => {
  const plan = {
    downloadable: [audiusTarget],
    onlineOnly: [
      {
        id: 'yt',
        title: 'Video YouTube',
        reason: 'I brani di YouTube si possono solo ascoltare in streaming.',
      },
    ],
    resolvable: [],
  };

  it('scarica gli elementi consentiti e mostra la nota online-only per gli altri', async () => {
    mocks.addDownloaded.mockResolvedValue({ ok: true, track: { id: 'local-1' } });
    mocks.fetch.mockResolvedValue(okResponse(audiusMeta));
    const container = await render(
      <OfflineDownloadButton label="Brani misti" plan={plan} signedIn />,
    );

    // La nota online-only cita il brano YouTube che resta in streaming.
    expect(container.textContent).toContain('Video YouTube');
    expect(container.textContent).toContain('streaming');

    const button = findButton(container, 'Scarica per offline');
    if (!button) throw new Error('Pulsante di download non trovato.');
    expect(button.getAttribute('aria-label')).toContain('Brani misti');

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.fetch).toHaveBeenCalledWith(
      '/api/music/audius/tracks/track-71/download',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mocks.addDownloaded).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalled();
    expect(container.textContent).toContain('disponibile offline');
  });

  it('senza login mostra la nota per accedere, non il pulsante di download', async () => {
    const container = await render(
      <OfflineDownloadButton label="Brani misti" plan={plan} signedIn={false} />,
    );
    expect(findButton(container, 'Scarica per offline')).toBeUndefined();
    expect(container.textContent).toContain('Accedi');
    expect(container.querySelector('a[href="/login"]')).not.toBeNull();
  });

  it('una playlist senza nulla di scaricabile lo dice chiaramente', async () => {
    const container = await render(
      <OfflineDownloadButton
        label="Solo YouTube"
        plan={{ downloadable: [], onlineOnly: plan.onlineOnly, resolvable: [] }}
        signedIn
      />,
    );
    expect(container.textContent).toContain('Nessun brano di questa playlist');
    expect(findButton(container, 'Scarica per offline')).toBeUndefined();
  });

  const notDownloadable: OfflineDownloadTarget = {
    id: 'item-audius-2',
    title: 'Brano non scaricabile',
    endpoint: { kind: 'audius', trackId: 'track-72' },
  };

  it('dopo un lotto elenca con un motivo i candidati Audius che il server lascia solo in streaming', async () => {
    mocks.addDownloaded.mockResolvedValue({ ok: true, track: { id: 'local-1' } });
    // track-71 è scaricabile; track-72 l'artista non l'ha reso scaricabile → 403 not_downloadable.
    mocks.fetch.mockImplementation(async (url: string) =>
      url === '/api/music/audius/tracks/track-72/download'
        ? errResponse(403, {
            error: 'not_downloadable',
            message: 'L’artista non ha reso scaricabile questo brano.',
          })
        : okResponse(audiusMeta),
    );
    const container = await render(
      <OfflineDownloadButton
        label="Brani Audius"
        plan={{ downloadable: [audiusTarget, notDownloadable], onlineOnly: [], resolvable: [] }}
        signedIn
      />,
    );
    const button = findButton(container, 'Scarica per offline');
    if (!button) throw new Error('Pulsante di download non trovato.');
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Uno salvato, uno riportato tra i soli-streaming: entrambi resi conto, nessuno sparito.
    expect(container.textContent).toContain('1 brano disponibile offline');
    expect(container.textContent).toContain('resta solo in streaming');
    expect(container.textContent).toContain('Brano non scaricabile');
    expect(container.textContent).toContain('L’artista non ha reso scaricabile questo brano.');
  });

  it('se il server lascia TUTTO solo in streaming, spiega perché invece del solo "Nessun brano scaricato"', async () => {
    mocks.fetch.mockResolvedValue(
      errResponse(403, {
        error: 'not_downloadable',
        message: 'L’artista non ha reso scaricabile questo brano.',
      }),
    );
    const container = await render(
      <OfflineDownloadButton
        label="Audius non scaricabili"
        plan={{ downloadable: [notDownloadable], onlineOnly: [], resolvable: [] }}
        signedIn
      />,
    );
    const button = findButton(container, 'Scarica per offline');
    if (!button) throw new Error('Pulsante di download non trovato.');
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.addDownloaded).not.toHaveBeenCalled();
    expect(container.textContent).toContain('restano solo in streaming');
    expect(container.textContent).toContain('L’artista non ha reso scaricabile questo brano.');
    // Non deve restare la nota nuda e priva di spiegazione.
    expect(container.textContent).not.toContain('Nessun brano scaricato.');
  });
});

describe('DownloadedTrackCredit', () => {
  it('un brano Audius scaricato mostra copyright, OML e link al brano', async () => {
    const container = await render(
      <DownloadedTrackCredit
        source="audius-download"
        attribution={audiusMeta.attribution}
        title="Brano OML"
      />,
    );
    expect(container.textContent).toContain('© 2025 Artista');
    expect(container.textContent).toContain('Audius Open Music License');
    const omlLink = container.querySelector<HTMLAnchorElement>(`a[href="${OML_URL}"]`);
    expect(omlLink?.target).toBe('_blank');
    expect(omlLink?.rel).toContain('noopener');
    expect(
      container.querySelector('a[href="https://audius.co/artista/brano-oml"]')?.textContent,
    ).toContain('Brano su Audius');
  });

  it('un file locale non porta nessun credito', async () => {
    const container = await render(<DownloadedTrackCredit source="local" attribution={null} />);
    expect(container.textContent).toBe('');
  });
});
