// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  token: 'tok_test' as string | undefined,
}));

vi.mock('@vercel/blob', () => ({ list: mocks.list }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));

import { isHomeTracksConfigured, listHomeTracks } from '@/lib/music/home-tracks.server';

function blob(pathname: string, url: string, uploadedAt: string) {
  return { pathname, url, downloadUrl: url, size: 1000, uploadedAt: new Date(uploadedAt) };
}
function page(blobs: ReturnType<typeof blob>[], hasMore = false, cursor?: string) {
  return { blobs, hasMore, cursor };
}

const PUBLIC = 'https://store.public.blob.vercel-storage.com';
const PRIVATE = 'https://store.private.blob.vercel-storage.com';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.token = 'tok_test';
});

describe('isHomeTracksConfigured', () => {
  it('true con token, false senza', () => {
    mocks.token = 'tok_test';
    expect(isHomeTracksConfigured()).toBe(true);
    mocks.token = undefined;
    expect(isHomeTracksConfigured()).toBe(false);
  });
});

describe('listHomeTracks', () => {
  it('elenca solo audio, esclude gli upload utenti, ordina dal più recente', async () => {
    mocks.list.mockResolvedValue(
      page([
        blob('ciao-mondo.mp3', `${PUBLIC}/ciao-mondo.mp3`, '2026-01-01T00:00:00.000Z'),
        blob('bella.wav', `${PUBLIC}/bella.wav`, '2026-03-01T00:00:00.000Z'),
        blob(
          'public-uploads/di-un-utente.mp3',
          `${PUBLIC}/public-uploads/di-un-utente.mp3`,
          '2026-05-01T00:00:00.000Z',
        ),
        blob('copertina.png', `${PUBLIC}/copertina.png`, '2026-04-01T00:00:00.000Z'),
      ]),
    );
    const items = await listHomeTracks();
    expect(items.map((i) => i.id)).toEqual(['bella.wav', 'ciao-mondo.mp3']);
    expect(items[0]?.title).toBe('Bella');
    expect(items[1]?.title).toBe('Ciao mondo');
    // File su host pubblico → stream diretto dal CDN.
    expect(items[0]?.streamUrl).toBe(`${PUBLIC}/bella.wav`);
    expect(items[0]?.durationSeconds).toBe(0);
    expect(items[0]?.artist).toBeNull();
  });

  it('un file PRIVATO è servito dal proxy same-origin, non dall’URL diretto', async () => {
    mocks.list.mockResolvedValue(
      page([blob('mia canzone.m4a', `${PRIVATE}/mia%20canzone.m4a`, '2026-01-01T00:00:00.000Z')]),
    );
    const items = await listHomeTracks();
    expect(items[0]?.streamUrl).toBe('/api/music/home-tracks/stream?p=mia%20canzone.m4a');
  });

  it('ricava il titolo dalla cartella/nome e rispetta i nomi già leggibili', async () => {
    mocks.list.mockResolvedValue(
      page([
        blob('home/Bella Ciao.mp3', `${PUBLIC}/home/Bella%20Ciao.mp3`, '2026-01-01T00:00:00.000Z'),
      ]),
    );
    const items = await listHomeTracks();
    expect(items[0]?.title).toBe('Bella Ciao');
  });

  it('pagina oltre la prima pagina (cursore) per non perdere brani quando lo store cresce', async () => {
    mocks.list
      .mockResolvedValueOnce(
        page([blob('a.mp3', `${PUBLIC}/a.mp3`, '2026-01-01T00:00:00.000Z')], true, 'cur1'),
      )
      .mockResolvedValueOnce(
        page([blob('b.mp3', `${PUBLIC}/b.mp3`, '2026-02-01T00:00:00.000Z')], false),
      );
    const items = await listHomeTracks();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list.mock.calls[1]?.[0]).toMatchObject({ cursor: 'cur1' });
    // Ordinati per data: b (feb) prima di a (gen).
    expect(items.map((i) => i.id)).toEqual(['b.mp3', 'a.mp3']);
  });

  it('ritorna [] senza token (storage non configurato)', async () => {
    mocks.token = undefined;
    const items = await listHomeTracks();
    expect(items).toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('ritorna [] se list() va in errore (degradazione, niente crash della Home)', async () => {
    mocks.list.mockRejectedValue(new Error('blob down'));
    expect(await listHomeTracks()).toEqual([]);
  });

  it('se una pagina successiva fallisce, mostra comunque quanto già raccolto', async () => {
    mocks.list
      .mockResolvedValueOnce(
        page([blob('ok.mp3', `${PUBLIC}/ok.mp3`, '2026-01-01T00:00:00.000Z')], true, 'cur1'),
      )
      .mockRejectedValueOnce(new Error('timeout'));
    const items = await listHomeTracks();
    expect(items.map((i) => i.id)).toEqual(['ok.mp3']);
  });
});
