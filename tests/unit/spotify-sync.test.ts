// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const db = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  itemFindMany: vi.fn(),
  itemDeleteMany: vi.fn((_args?: unknown) => 'deleteOp'),
  itemCreateMany: vi.fn((_args?: { data: Array<{ sourceId: string }> }) => 'createOp'),
  update: vi.fn((_args?: unknown) => 'updateOp'),
  transaction: vi.fn(async () => []),
  existing: null as { id: string; name: string } | null,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    userMusicCollection: { findFirst: db.findFirst, create: db.create, update: db.update },
    userMusicCollectionItem: {
      findMany: db.itemFindMany,
      deleteMany: db.itemDeleteMany,
      createMany: db.itemCreateMany,
    },
    $transaction: db.transaction,
  },
}));
vi.mock('@/lib/music/collections.server', () => ({ isFavoritesName: () => false }));

import { songSourceId, upsertSpotifySongPlaylist } from '@/lib/business/track-list-import.server';
import { dbToSpotifySource, spotifySourceDb } from '@/lib/spotify/import.server';

const track = (title: string) => ({ title, artist: null, sourceUrl: null, durationSeconds: 100 });

beforeEach(() => {
  vi.clearAllMocks();
  db.itemDeleteMany.mockReturnValue('deleteOp');
  db.itemCreateMany.mockReturnValue('createOp');
  db.update.mockReturnValue('updateOp');
  db.transaction.mockResolvedValue([]);
  // findFirst: la ricerca per spotifySource decide create vs update; quella per nome è "libera".
  db.findFirst.mockImplementation(async ({ where }: { where: { spotifySource?: string } }) =>
    where.spotifySource !== undefined ? db.existing : null,
  );
});

describe('chiavi sorgente Spotify', () => {
  it('round-trip saved e playlist', () => {
    expect(spotifySourceDb({ kind: 'saved' })).toBe('saved');
    expect(spotifySourceDb({ kind: 'playlist', id: 'a'.repeat(22) })).toBe(
      `playlist:${'a'.repeat(22)}`,
    );
    expect(dbToSpotifySource('saved')).toEqual({ kind: 'saved' });
    expect(dbToSpotifySource(`playlist:${'b'.repeat(22)}`)).toEqual({
      kind: 'playlist',
      id: 'b'.repeat(22),
    });
    // Chiave non più valida (id malformato) → null, così la sync la salta.
    expect(dbToSpotifySource('playlist:troppo-corto')).toBeNull();
    expect(dbToSpotifySource('altro')).toBeNull();
  });
});

describe('upsertSpotifySongPlaylist', () => {
  it('crea una nuova playlist quando la sorgente non è ancora importata', async () => {
    db.existing = null;
    db.create.mockResolvedValue({ id: 'new-col' });
    const result = await upsertSpotifySongPlaylist('u1', 'saved', 'Brani salvati su Spotify', [
      track('A'),
      track('B'),
    ]);
    expect(result).toMatchObject({ collectionId: 'new-col', created: true, added: 2, removed: 0 });
    // Salva la chiave sorgente, così l'Aggiorna ritrova questa playlist.
    expect(db.create.mock.calls[0]?.[0].data).toMatchObject({ spotifySource: 'saved' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('aggiorna a specchio esatto una playlist già importata (aggiunge e rimuove)', async () => {
    db.existing = { id: 'col-1', name: 'Brani salvati su Spotify' };
    // Prima: A, B. Dopo: A, C → +1 (C), −1 (B).
    db.itemFindMany.mockResolvedValue([
      { sourceId: songSourceId('A', null) },
      { sourceId: songSourceId('B', null) },
    ]);
    const result = await upsertSpotifySongPlaylist('u1', 'saved', 'Brani salvati su Spotify', [
      track('A'),
      track('C'),
    ]);
    expect(result).toMatchObject({ collectionId: 'col-1', created: false, added: 1, removed: 1 });
    // Specchio esatto: una transazione che svuota gli item "song" e ricrea l'insieme nuovo.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.itemDeleteMany).toHaveBeenCalledWith({
      where: { collectionId: 'col-1', source: 'song' },
    });
    const created = db.itemCreateMany.mock.calls[0]?.[0]?.data ?? [];
    expect(created.map((item) => item.sourceId)).toEqual([
      songSourceId('A', null),
      songSourceId('C', null),
    ]);
    expect(db.create).not.toHaveBeenCalled();
  });
});
