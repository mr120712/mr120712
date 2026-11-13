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

const HOST = 'https://store.public.blob.vercel-storage.com';

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
    mocks.list.mockResolvedValue({
      blobs: [
        blob('ciao-mondo.mp3', `${HOST}/ciao-mondo.mp3`, '2026-01-01T00:00:00.000Z'),
        blob('bella.wav', `${HOST}/bella.wav`, '2026-03-01T00:00:00.000Z'),
        blob(
          'public-uploads/di-un-utente.mp3',
          `${HOST}/public-uploads/di-un-utente.mp3`,
          '2026-05-01T00:00:00.000Z',
        ),
        blob('copertina.png', `${HOST}/copertina.png`, '2026-04-01T00:00:00.000Z'),
      ],
    });
    const items = await listHomeTracks();
    expect(items.map((i) => i.id)).toEqual(['bella.wav', 'ciao-mondo.mp3']);
    expect(items[0]?.title).toBe('Bella');
    expect(items[1]?.title).toBe('Ciao mondo');
    expect(items[0]?.streamUrl).toBe(`${HOST}/bella.wav`);
    expect(items[0]?.durationSeconds).toBe(0);
    expect(items[0]?.artist).toBeNull();
  });

  it('ricava il titolo dalla cartella/nome e rispetta i nomi già leggibili', async () => {
    mocks.list.mockResolvedValue({
      blobs: [
        blob('home/Bella Ciao.mp3', `${HOST}/home/Bella%20Ciao.mp3`, '2026-01-01T00:00:00.000Z'),
      ],
    });
    const items = await listHomeTracks();
    expect(items[0]?.title).toBe('Bella Ciao');
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

  it('scarta un oggetto con URL non valido invece di rompere tutto', async () => {
    mocks.list.mockResolvedValue({
      blobs: [
        blob('ok.mp3', `${HOST}/ok.mp3`, '2026-01-01T00:00:00.000Z'),
        blob('cattivo.mp3', 'https://evil.example.com/cattivo.mp3', '2026-02-01T00:00:00.000Z'),
      ],
    });
    const items = await listHomeTracks();
    expect(items.map((i) => i.id)).toEqual(['ok.mp3']);
  });
});
