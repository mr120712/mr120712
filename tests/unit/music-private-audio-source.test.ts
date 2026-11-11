// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sign: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/modules/file-upload/server', () => ({ signFileUrls: mocks.sign }));

import {
  isPrivateAudioSourceAvailable,
  isPrivateEvidenceFileAvailable,
} from '@/lib/music/private-audio-source.server';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sign.mockResolvedValue(new Map([['private-key', 'https://private.storage/signed']]));
});

afterEach(() => vi.unstubAllGlobals());

describe('verifica della sorgente audio privata', () => {
  it('controlla un solo byte e richiede MIME, lunghezza e intervallo registrati', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([7]), {
          status: 206,
          headers: {
            'content-type': 'audio/mp4',
            'content-length': '1',
            'content-range': 'bytes 0-0/2000',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await isPrivateAudioSourceAvailable('private-key', 'audio/mp4', 2000)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://private.storage/signed',
      expect.objectContaining({
        headers: { Range: 'bytes=0-0' },
        cache: 'no-store',
        redirect: 'error',
      }),
    );
  });

  it.each([
    ['MIME discordante', 'application/pdf', 'audio/mp4', 'bytes 0-0/2000'],
    ['dimensione discordante', 'audio/mp4', 'audio/mp4', 'bytes 0-0/1999'],
  ])(
    'nega storage non corrispondente per %s',
    async (_name, mimeType, expectedMimeType, contentRange) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(new Uint8Array([7]), {
              status: 206,
              headers: {
                'content-type': mimeType,
                'content-length': '1',
                'content-range': contentRange,
              },
            }),
        ),
      );
      expect(await isPrivateAudioSourceAvailable('private-key', expectedMimeType, 2000)).toBe(
        false,
      );
    },
  );

  it('nega quando la firma o lo storage privato non sono disponibili', async () => {
    mocks.sign.mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await isPrivateAudioSourceAvailable('private-key', 'audio/mp4', 2000)).toBe(false);
    mocks.sign.mockResolvedValueOnce(new Map());
    expect(await isPrivateAudioSourceAvailable('private-key', 'audio/mp4', 2000)).toBe(false);
  });

  it('verifica firma, MIME, lunghezza e Range del documento dei diritti privato', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), {
            status: 206,
            headers: {
              'content-type': 'application/pdf',
              'content-length': '8',
              'content-range': 'bytes 0-7/900',
            },
          }),
      ),
    );
    expect(await isPrivateEvidenceFileAvailable('private-key', 'application/pdf', 900)).toBe(true);
  });

  it.each([
    ['firma non PDF', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])],
    ['intervallo non conforme', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])],
  ])('nega la prova privata con %s', async (reason, bytes) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(bytes, {
            status: reason === 'intervallo non conforme' ? 200 : 206,
            headers: {
              'content-type': 'application/pdf',
              'content-length': reason === 'intervallo non conforme' ? '900' : '8',
              'content-range': 'bytes 0-7/900',
            },
          }),
      ),
    );
    expect(await isPrivateEvidenceFileAvailable('private-key', 'application/pdf', 900)).toBe(false);
  });
});
