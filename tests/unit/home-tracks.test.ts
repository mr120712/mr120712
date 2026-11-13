// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  listPage: vi.fn(),
  presign: vi.fn(),
  configured: true as boolean,
}));

vi.mock('@/lib/music/s3-storage.server', () => ({
  isS3Configured: () => mocks.configured,
  listObjectsPage: mocks.listPage,
  presignGetUrl: mocks.presign,
}));

import { isHomeTracksConfigured, listHomeTracks } from '@/lib/music/home-tracks.server';

function obj(key: string, lastModified: string) {
  return { key, size: 1000, lastModified: new Date(lastModified) };
}
function pageOf(objects: ReturnType<typeof obj>[], nextToken?: string) {
  return { objects, nextToken };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.configured = true;
  // URL GET firmato: firma locale sul bucket S3 (nessuna rete).
  mocks.presign.mockImplementation(
    async (key: string) =>
      `https://bucket.s3.eu-west-1.amazonaws.com/${encodeURIComponent(key)}?X-Amz-Signature=abc`,
  );
});

describe('isHomeTracksConfigured', () => {
  it('rispecchia la configurazione di AWS S3', () => {
    mocks.configured = true;
    expect(isHomeTracksConfigured()).toBe(true);
    mocks.configured = false;
    expect(isHomeTracksConfigured()).toBe(false);
  });
});

describe('listHomeTracks', () => {
  it('elenca solo audio, esclude gli upload utenti, ordina dal più recente', async () => {
    mocks.listPage.mockResolvedValue(
      pageOf([
        obj('ciao-mondo.mp3', '2026-01-01T00:00:00.000Z'),
        obj('bella.wav', '2026-03-01T00:00:00.000Z'),
        obj('public-uploads/di-un-utente.mp3', '2026-05-01T00:00:00.000Z'),
        obj('copertina.png', '2026-04-01T00:00:00.000Z'),
      ]),
    );
    const items = await listHomeTracks();
    expect(items.map((i) => i.id)).toEqual(['bella.wav', 'ciao-mondo.mp3']);
    expect(items[0]?.title).toBe('Bella');
    expect(items[1]?.title).toBe('Ciao mondo');
    // streamUrl è un URL GET firmato su S3 (il player lo riproduce diretto, seek/Range nativi).
    expect(items[0]?.streamUrl).toContain('amazonaws.com');
    expect(items[0]?.streamUrl).toContain('X-Amz-Signature');
    expect(items[0]?.durationSeconds).toBe(0);
    expect(items[0]?.artist).toBeNull();
  });

  it('ricava il titolo dalla cartella/nome e rispetta i nomi già leggibili', async () => {
    mocks.listPage.mockResolvedValue(
      pageOf([obj('home/Bella Ciao.mp3', '2026-01-01T00:00:00.000Z')]),
    );
    const items = await listHomeTracks();
    expect(items[0]?.title).toBe('Bella Ciao');
  });

  it('pagina oltre la prima pagina (token) per non perdere brani quando lo store cresce', async () => {
    mocks.listPage
      .mockResolvedValueOnce(pageOf([obj('a.mp3', '2026-01-01T00:00:00.000Z')], 'cur1'))
      .mockResolvedValueOnce(pageOf([obj('b.mp3', '2026-02-01T00:00:00.000Z')]));
    const items = await listHomeTracks();
    expect(mocks.listPage).toHaveBeenCalledTimes(2);
    expect(mocks.listPage.mock.calls[1]?.[0]).toBe('cur1');
    // Ordinati per data: b (feb) prima di a (gen).
    expect(items.map((i) => i.id)).toEqual(['b.mp3', 'a.mp3']);
  });

  it('ritorna [] se S3 non è configurato', async () => {
    mocks.configured = false;
    const items = await listHomeTracks();
    expect(items).toEqual([]);
    expect(mocks.listPage).not.toHaveBeenCalled();
  });

  it('ritorna [] se il listing va in errore (degradazione, niente crash della Home)', async () => {
    mocks.listPage.mockRejectedValue(new Error('s3 down'));
    expect(await listHomeTracks()).toEqual([]);
  });

  it('se una pagina successiva fallisce, mostra comunque quanto già raccolto', async () => {
    mocks.listPage
      .mockResolvedValueOnce(pageOf([obj('ok.mp3', '2026-01-01T00:00:00.000Z')], 'cur1'))
      .mockRejectedValueOnce(new Error('timeout'));
    const items = await listHomeTracks();
    expect(items.map((i) => i.id)).toEqual(['ok.mp3']);
  });
});
