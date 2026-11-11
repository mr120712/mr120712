// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findSources: vi.fn(),
  findEvidence: vi.fn(),
  signFiles: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    musicPlaybackSource: { findMany: mocks.findSources },
    musicRightsEvidence: { findMany: mocks.findEvidence },
  },
}));
vi.mock('@/modules/file-upload/server', () => ({ signFileUrls: mocks.signFiles }));

import {
  resolveVerifiedTrackPlayback,
  resolveVerifiedTrackPreview,
} from '@/lib/music/streaming-rights.server';

const now = new Date('2026-11-08T12:00:00.000Z');

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'source-1',
    albumId: 'album-1',
    trackId: 'track-1',
    completeness: 'preview_excerpt',
    fileKey: 'company_1/private/music/preview-1.m4a',
    mimeType: 'audio/mp4',
    byteLength: 2048,
    durationSeconds: 40,
    active: true,
    createdByUserId: 'admin-1',
    createdAt: new Date('2026-11-01T12:00:00.000Z'),
    updatedAt: new Date('2026-11-01T12:00:00.000Z'),
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evidence-1',
    sourceId: 'source-1',
    albumId: 'album-1',
    trackId: 'track-1',
    grant: 'solco_preview',
    durationSeconds: 40,
    evidenceFileKey: 'company_1/private/rights/document-1.pdf',
    evidenceMimeType: 'application/pdf',
    evidenceByteLength: 4096,
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    validUntil: new Date('2026-12-01T00:00:00.000Z'),
    verifiedAt: new Date('2026-11-01T12:00:00.000Z'),
    verifiedByUserId: 'admin-1',
    revokedAt: null,
    createdAt: new Date('2026-11-01T12:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findSources.mockResolvedValue([source()]);
  mocks.findEvidence.mockResolvedValue([evidence()]);
  mocks.signFiles.mockResolvedValue(
    new Map([['company_1/private/music/preview-1.m4a', 'https://storage.test/signed-audio']]),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolver di fonti e prove musicali', () => {
  it('restituisce la sola fonte privata dell’estratto quando fonte e prova correnti corrispondono', async () => {
    mocks.findSources.mockResolvedValue([source({ byteLength: 4 })]);
    const result = await resolveVerifiedTrackPreview('album-1', 'track-1', now);

    expect(result).toMatchObject({
      state: 'verified_preview',
      albumId: 'album-1',
      trackId: 'track-1',
      source: {
        sourceId: 'source-1',
        completeness: 'preview_excerpt',
        durationSeconds: 40,
        byteLength: 4,
      },
      rights: {
        evidenceId: 'evidence-1',
        sourceId: 'source-1',
        grant: 'solco_preview',
        durationSeconds: 40,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/fileKey|fileUrl|audioUrl|mediaBytes/i);
    expect(mocks.signFiles).not.toHaveBeenCalled();

    if (result.state !== 'verified_preview') throw new Error('La fonte non è verificata');
    const bytes = new Uint8Array([2, 3]);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=1-2');
      return new Response(bytes, {
        status: 206,
        headers: {
          'content-type': 'audio/mp4',
          'content-length': '2',
          'content-range': 'bytes 1-2/4',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await result.openPreview('bytes=1-2');

    expect(mocks.signFiles).toHaveBeenCalledWith(['company_1/private/music/preview-1.m4a']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(206);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3]);
  });

  it('dichiara mancante la fonte e non abilita audio o riferimenti quando non c’è un asset', async () => {
    mocks.findSources.mockResolvedValue([]);

    const result = await resolveVerifiedTrackPreview('album-1', 'track-1', now);

    expect(result).toEqual({
      state: 'unavailable',
      albumId: 'album-1',
      trackId: 'track-1',
      reason: 'source_missing',
    });
    expect(JSON.stringify(result)).not.toMatch(/fileKey|fileUrl|previewUrl|\.m4a/i);
  });

  it.each([
    ['scaduta', { validUntil: new Date('2026-11-08T11:59:59.999Z') }],
    ['riferita a un altro brano', { trackId: 'track-2' }],
    ['riferita a un altro album', { albumId: 'album-2' }],
    ['riferita a un altro estratto', { durationSeconds: 39.5 }],
    ['priva di file documentale', { evidenceFileKey: '' }],
  ])('nega la preview con prova %s', async (_label, overrides) => {
    mocks.findEvidence.mockResolvedValue([evidence(overrides)]);

    const result = await resolveVerifiedTrackPreview('album-1', 'track-1', now);

    expect(result).toMatchObject({
      state: 'unavailable',
      reason: 'rights_unverified',
      albumId: 'album-1',
      trackId: 'track-1',
    });
  });

  it('non tratta un file integrale come estratto e blocca estratti oltre 40 secondi', async () => {
    mocks.findSources
      .mockResolvedValueOnce([source({ completeness: 'full_track' })])
      .mockResolvedValueOnce([source({ durationSeconds: 40.01 })]);

    const fullAsPreview = await resolveVerifiedTrackPreview('album-1', 'track-1', now);
    const overlong = await resolveVerifiedTrackPreview('album-1', 'track-1', now);

    expect(fullAsPreview).toMatchObject({ state: 'unavailable', reason: 'source_missing' });
    expect(overlong).toMatchObject({ state: 'unavailable', reason: 'source_missing' });
    expect(mocks.findEvidence).not.toHaveBeenCalled();
  });

  it('mantiene la fonte integrale solo con prova completa, corrente e riferita allo stesso oggetto', async () => {
    mocks.findSources.mockResolvedValue([
      source({ completeness: 'full_track', durationSeconds: 183.2 }),
    ]);
    mocks.findEvidence.mockResolvedValue([
      evidence({ grant: 'solco_streaming', durationSeconds: 183.2 }),
    ]);

    const result = await resolveVerifiedTrackPlayback('album-1', 'track-1', now);

    expect(result).toMatchObject({
      state: 'verified',
      source: { completeness: 'full_track', durationSeconds: 183.2 },
      rights: { grant: 'solco_streaming', durationSeconds: 183.2 },
    });
  });

  it.each([
    ['fonte assente o disattivata', [], [evidence({ completeness: undefined })]],
    [
      'fonte di un altro album',
      [source({ completeness: 'full_track', albumId: 'album-other' })],
      [evidence({ grant: 'solco_streaming' })],
    ],
    [
      'fonte di un altro brano',
      [source({ completeness: 'full_track', trackId: 'track-other' })],
      [evidence({ grant: 'solco_streaming' })],
    ],
    [
      'fonte non completa',
      [source({ completeness: 'preview_excerpt' })],
      [evidence({ grant: 'solco_streaming' })],
    ],
    [
      'fonte con MIME non audio',
      [source({ completeness: 'full_track', mimeType: 'application/pdf' })],
      [evidence({ grant: 'solco_streaming' })],
    ],
    ['prova mancante', [source({ completeness: 'full_track' })], []],
    [
      'grant di sola anteprima',
      [source({ completeness: 'full_track' })],
      [evidence({ grant: 'solco_preview' })],
    ],
    [
      'prova revocata',
      [source({ completeness: 'full_track' })],
      [evidence({ grant: 'solco_streaming', revokedAt: now })],
    ],
    [
      'prova scaduta',
      [source({ completeness: 'full_track' })],
      [evidence({ grant: 'solco_streaming', validUntil: new Date(now.getTime() - 1) })],
    ],
    [
      'prova non ancora valida',
      [source({ completeness: 'full_track' })],
      [evidence({ grant: 'solco_streaming', validFrom: new Date(now.getTime() + 1) })],
    ],
    [
      'identità verificatrice assente',
      [source({ completeness: 'full_track' })],
      [evidence({ grant: 'solco_streaming', verifiedByUserId: '' })],
    ],
    [
      'durata discordante',
      [source({ completeness: 'full_track', durationSeconds: 183 })],
      [evidence({ grant: 'solco_streaming', durationSeconds: 182 })],
    ],
  ])('chiude la risoluzione per %s', async (_label, sources, evidences) => {
    mocks.findSources.mockResolvedValue(sources);
    mocks.findEvidence.mockResolvedValue(evidences);
    const result = await resolveVerifiedTrackPlayback('album-1', 'track-1', now);
    expect(result.state).toBe('unavailable');
  });

  it('nega fonti o prove ambigue e un errore di database non produce un risultato verificato', async () => {
    mocks.findSources.mockResolvedValue([
      source({ completeness: 'full_track' }),
      source({
        id: 'source-2',
        fileKey: 'company_1/private/music/track-2.m4a',
        completeness: 'full_track',
      }),
    ]);
    expect(await resolveVerifiedTrackPlayback('album-1', 'track-1', now)).toMatchObject({
      state: 'ambiguous',
    });

    mocks.findSources.mockResolvedValue([source({ completeness: 'full_track' })]);
    mocks.findEvidence.mockResolvedValue([
      evidence({ grant: 'solco_streaming' }),
      evidence({ id: 'evidence-2', grant: 'solco_streaming' }),
    ]);
    expect(await resolveVerifiedTrackPlayback('album-1', 'track-1', now)).toMatchObject({
      state: 'ambiguous',
    });

    mocks.findSources.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(resolveVerifiedTrackPlayback('album-1', 'track-1', now)).rejects.toThrow(
      'database unavailable',
    );
  });
});
