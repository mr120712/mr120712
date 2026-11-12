// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  historyFindMany: vi.fn(),
  groupBy: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    userRecording: {
      count: mocks.count,
      create: mocks.create,
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      findUnique: mocks.findUnique,
      deleteMany: mocks.deleteMany,
      updateMany: mocks.updateMany,
    },
    userPlaybackHistory: {
      findMany: mocks.historyFindMany,
      groupBy: mocks.groupBy,
    },
  },
}));

vi.mock('@/lib/music/private-audio-source.server', () => {
  class InvalidPrivateAudioSource extends Error {}
  class PrivateAudioStorageUnavailable extends Error {}
  return {
    inspectRecordingSource: mocks.inspect,
    openPrivateAudioSource: vi.fn(),
    InvalidPrivateAudioSource,
    PrivateAudioStorageUnavailable,
  };
});

import { InvalidPrivateAudioSource } from '@/lib/music/private-audio-source.server';
import {
  deleteRecording,
  getOwnedRecording,
  getStreamableRecording,
  InvalidRecordingSource,
  listPublicRecordingsChart,
  listRecordings,
  listRecordingsChart,
  MAX_RECORDINGS_PER_USER,
  RecordingLimitReached,
  registerRecording,
  reportRecording,
  setRecordingPublished,
} from '@/lib/music/recordings.server';

const input = {
  title: 'La mia canzone',
  fileKey: 'company_1/private/files/abc.webm',
  mimeType: 'audio/webm',
  byteLength: 123_456,
  elapsedSeconds: 20,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('registerRecording', () => {
  it('ispeziona, arrotonda la durata per eccesso e salva', async () => {
    mocks.count.mockResolvedValue(0);
    mocks.inspect.mockResolvedValue({
      mimeType: 'audio/webm',
      byteLength: 123_456,
      durationSeconds: 12.2,
    });
    mocks.create.mockResolvedValue({
      id: 'c'.repeat(25),
      title: 'La mia canzone',
      durationSeconds: 13,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      published: false,
    });

    const recording = await registerRecording('user-1', input);

    expect(mocks.inspect).toHaveBeenCalledWith(input.fileKey, input.mimeType, input.byteLength);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', durationSeconds: 13 }),
      }),
    );
    expect(recording).toEqual({
      id: 'c'.repeat(25),
      title: 'La mia canzone',
      durationSeconds: 13,
      createdAt: '2026-01-01T00:00:00.000Z',
      published: false,
    });
  });

  it('usa la durata del client quando il contenitore non la riporta (WebM/Opus)', async () => {
    mocks.count.mockResolvedValue(0);
    mocks.inspect.mockResolvedValue({
      mimeType: 'audio/webm',
      byteLength: 123_456,
      durationSeconds: null,
    });
    mocks.create.mockResolvedValue({
      id: 'c'.repeat(25),
      title: 'La mia canzone',
      durationSeconds: 20,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      published: false,
    });

    await registerRecording('user-1', input);

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationSeconds: 20 }),
      }),
    );
  });

  it('rifiuta quando il tetto per utente è raggiunto', async () => {
    mocks.count.mockResolvedValue(MAX_RECORDINGS_PER_USER);
    await expect(registerRecording('user-1', input)).rejects.toBeInstanceOf(RecordingLimitReached);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('converte un audio non valido in InvalidRecordingSource', async () => {
    mocks.count.mockResolvedValue(0);
    mocks.inspect.mockRejectedValue(new InvalidPrivateAudioSource());
    await expect(registerRecording('user-1', input)).rejects.toBeInstanceOf(InvalidRecordingSource);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('tratta una chiave file duplicata come sorgente non valida', async () => {
    mocks.count.mockResolvedValue(0);
    mocks.inspect.mockResolvedValue({
      mimeType: 'audio/webm',
      byteLength: 123_456,
      durationSeconds: 5,
    });
    mocks.create.mockRejectedValue({ code: 'P2002' });
    await expect(registerRecording('user-1', input)).rejects.toBeInstanceOf(InvalidRecordingSource);
  });
});

describe('letture e cancellazione', () => {
  it('elenca le registrazioni dell’utente', async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: 'a'.repeat(25),
        title: 'Uno',
        durationSeconds: 30,
        createdAt: new Date('2026-02-02T10:00:00.000Z'),
        published: true,
      },
    ]);
    const list = await listRecordings('user-1');
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    expect(list).toEqual([
      {
        id: 'a'.repeat(25),
        title: 'Uno',
        durationSeconds: 30,
        createdAt: '2026-02-02T10:00:00.000Z',
        published: true,
      },
    ]);
  });

  it('getOwnedRecording filtra per id e utente', async () => {
    mocks.findFirst.mockResolvedValue({ fileKey: 'k', mimeType: 'audio/webm', byteLength: 10 });
    const row = await getOwnedRecording('user-1', 'rec-1');
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rec-1', userId: 'user-1' } }),
    );
    expect(row).toEqual({ fileKey: 'k', mimeType: 'audio/webm', byteLength: 10 });
  });

  it('deleteRecording ritorna true solo se qualcosa è stato eliminato', async () => {
    mocks.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await deleteRecording('user-1', 'rec-1')).toBe(true);
    mocks.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await deleteRecording('user-1', 'rec-2')).toBe(false);
  });
});

describe('listRecordingsChart', () => {
  it('unisce registrazioni e conteggi, ordina per ascolti, 0 per le mai ascoltate', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'a', title: 'A', durationSeconds: 30, createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 'b', title: 'B', durationSeconds: 40, createdAt: new Date('2026-02-01T00:00:00Z') },
      { id: 'c', title: 'C', durationSeconds: 50, createdAt: new Date('2026-03-01T00:00:00Z') },
    ]);
    mocks.historyFindMany.mockResolvedValue([
      { qualifiedId: 'recording:a', playCount: 5 },
      { qualifiedId: 'recording:c', playCount: 12 },
    ]);

    const chart = await listRecordingsChart('user-1');

    expect(chart).toEqual([
      { id: 'c', title: 'C', durationSeconds: 50, playCount: 12 },
      { id: 'a', title: 'A', durationSeconds: 30, playCount: 5 },
      { id: 'b', title: 'B', durationSeconds: 40, playCount: 0 },
    ]);
    expect(mocks.historyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          qualifiedId: { startsWith: 'recording:' },
        }),
      }),
    );
  });
});

describe('pubblicazione e moderazione', () => {
  it('setRecordingPublished pubblica e ritorna la registrazione aggiornata', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findFirst.mockResolvedValue({
      id: 'r'.repeat(25),
      title: 'Brano',
      durationSeconds: 20,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      published: true,
    });
    const updated = await setRecordingPublished('user-1', 'r'.repeat(25), true);
    expect(updated?.published).toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r'.repeat(25), userId: 'user-1' },
        data: expect.objectContaining({ published: true }),
      }),
    );
  });

  it('setRecordingPublished ritorna null se non è dell’utente', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(await setRecordingPublished('user-1', 'r'.repeat(25), true)).toBeNull();
  });

  it('getStreamableRecording: proprietario sì, non pubblicato no, pubblicato sì', async () => {
    mocks.findUnique.mockResolvedValue({
      userId: 'owner',
      published: false,
      fileKey: 'k',
      mimeType: 'audio/webm',
      byteLength: 10,
    });
    expect(await getStreamableRecording('owner', 'rec')).toEqual({
      fileKey: 'k',
      mimeType: 'audio/webm',
      byteLength: 10,
    });
    expect(await getStreamableRecording('altro', 'rec')).toBeNull();

    mocks.findUnique.mockResolvedValue({
      userId: 'owner',
      published: true,
      fileKey: 'k',
      mimeType: 'audio/webm',
      byteLength: 10,
    });
    expect(await getStreamableRecording('altro', 'rec')).not.toBeNull();
  });

  it('reportRecording incrementa e auto-ritira oltre la soglia', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    expect(await reportRecording('rec')).toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    // Il secondo updateMany ritira (published=false) oltre la soglia.
    expect(mocks.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ published: false }) }),
    );
  });

  it('reportRecording ritorna false se la registrazione pubblicata non esiste', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await reportRecording('rec')).toBe(false);
  });

  it('listPublicRecordingsChart somma gli ascolti di tutti e ordina', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'x', title: 'X', durationSeconds: 20 },
      { id: 'y', title: 'Y', durationSeconds: 30 },
    ]);
    mocks.groupBy.mockResolvedValue([
      { qualifiedId: 'recording:x', _sum: { playCount: 3 } },
      { qualifiedId: 'recording:y', _sum: { playCount: 9 } },
    ]);
    const chart = await listPublicRecordingsChart();
    expect(chart).toEqual([
      { id: 'y', title: 'Y', durationSeconds: 30, playCount: 9 },
      { id: 'x', title: 'X', durationSeconds: 20, playCount: 3 },
    ]);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { published: true } }),
    );
  });
});
