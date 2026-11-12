// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    userRecording: {
      count: mocks.count,
      create: mocks.create,
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      deleteMany: mocks.deleteMany,
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
  InvalidRecordingSource,
  listRecordings,
  MAX_RECORDINGS_PER_USER,
  RecordingLimitReached,
  registerRecording,
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
