// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/require-auth';

const mocks = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    upsert: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 1 })),
    updateMany: vi.fn(async () => ({ count: 1 })),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  });
  return {
    requireAuth: vi.fn(),
    sameOrigin: vi.fn(),
    prisma: {
      userSavedStation: model(),
      userPodcastFollow: model(),
      userMusicFolder: model(),
      userMusicCollection: model(),
      userPlaybackHistory: model(),
      userHiddenItem: model(),
    },
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/db', () => ({ prisma: mocks.prisma }));

import { GET, POST } from '@/app/api/music/library/route';

const account = { id: 'account-a' } as unknown as SessionUser;

function post(body: unknown) {
  return new Request('https://solco.test/api/music/library', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://solco.test' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue(account);
  mocks.sameOrigin.mockReturnValue(true);
});

describe('API Libreria', () => {
  it('richiede l’accesso', async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Response(null, { status: 401 }));
    const response = await GET(new Request('https://solco.test/api/music/library'));
    expect(response.status).toBe(401);
  });

  it('restituisce una Libreria vuota valida', async () => {
    const response = await GET(new Request('https://solco.test/api/music/library'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      stations: [],
      podcasts: [],
      folders: [],
      history: [],
      hidden: [],
    });
    expect(mocks.prisma.userPlaybackHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'account-a' } }),
    );
  });

  it('rifiuta modifiche da un’altra origine', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    const response = await POST(post({ action: 'clear_history' }));
    expect(response.status).toBe(403);
    expect(mocks.prisma.userPlaybackHistory.deleteMany).not.toHaveBeenCalled();
  });

  it('rifiuta dati non validi', async () => {
    const response = await POST(
      post({
        action: 'save_station',
        station: {
          stationId: 'x',
          name: 'Radio',
          artworkUrl: 'http://insecure',
          country: null,
          tags: null,
          homepage: null,
        },
      }),
    );
    expect(response.status).toBe(400);
  });

  it('registra un ascolto incrementando il conteggio, senza rileggere la Libreria', async () => {
    const response = await POST(
      post({
        action: 'record_play',
        track: {
          qualifiedId: 'radio:station-1',
          title: 'Radio Prova',
          artistName: 'Italy',
          artworkUrl: null,
          sourceLabel: 'Radio dal vivo',
          sourceUrl: null,
          albumId: null,
          durationSeconds: null,
          playbackMode: 'radio',
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const calls = mocks.prisma.userPlaybackHistory.upsert.mock.calls as unknown as unknown[][];
    const call = calls[0]?.[0] as {
      where: unknown;
      update: { playCount: unknown };
    };
    expect(call.where).toEqual({
      userId_qualifiedId: { userId: 'account-a', qualifiedId: 'radio:station-1' },
    });
    expect(call.update.playCount).toEqual({ increment: 1 });
    expect(mocks.prisma.userSavedStation.findMany).not.toHaveBeenCalled();
  });

  it('sposta una playlist solo in una cartella dell’utente', async () => {
    const response = await POST(
      post({ action: 'move_playlist', collectionId: 'playlist-1', folderId: 'folder-x' }),
    );
    expect(response.status).toBe(404);
    expect(mocks.prisma.userMusicFolder.findFirst).toHaveBeenCalledWith({
      where: { id: 'folder-x', userId: 'account-a' },
    });
    expect(mocks.prisma.userMusicCollection.updateMany).not.toHaveBeenCalled();
  });

  it('eliminando una cartella riporta le playlist nella radice', async () => {
    mocks.prisma.userMusicFolder.findFirst.mockResolvedValueOnce({ id: 'folder-1' } as never);
    const response = await POST(post({ action: 'delete_folder', folderId: 'folder-1' }));
    expect(response.status).toBe(200);
    expect(mocks.prisma.userMusicCollection.updateMany).toHaveBeenCalledWith({
      where: { userId: 'account-a', folderId: 'folder-1' },
      data: { folderId: null },
    });
  });
});
