// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signFiles = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/modules/file-upload/server', () => ({ signFileUrls: signFiles }));

import {
  inspectPrivateEvidenceFile,
  inspectPrivateAudioSource,
  InvalidPrivateEvidenceFile,
  InvalidPrivateAudioSource,
} from '@/lib/music/private-audio-source.server';

function makeSilentWav(durationSeconds: number) {
  const sampleRate = 8000;
  const dataLength = sampleRate * durationSeconds;
  const bytes = Buffer.alloc(44 + dataLength, 128);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + dataLength, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(dataLength, 40);
  return bytes;
}

describe('ispezione del file audio privato caricato', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signFiles.mockResolvedValue(new Map([['private/audio.wav', 'https://storage.test/signed']]));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('legge la durata effettiva dai byte audio invece di fidarsi dei metadati del catalogo', async () => {
    const bytes = makeSilentWav(1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(bytes, {
          headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.length) },
        }),
      ),
    );

    await expect(inspectPrivateAudioSource('private/audio.wav', 'audio/wav', bytes.length)).resolves.toMatchObject({
      mimeType: 'audio/wav',
      byteLength: bytes.length,
      durationSeconds: 1,
    });
  });

  it('rifiuta byte che non corrispondono a un file audio leggibile', async () => {
    const bytes = Buffer.from('non è audio');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(bytes, {
          headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.length) },
        }),
      ),
    );

    await expect(
      inspectPrivateAudioSource('private/audio.wav', 'audio/wav', bytes.length),
    ).rejects.toBeInstanceOf(InvalidPrivateAudioSource);
  });

  it('verifica che il file della prova abbia una firma PDF effettiva', async () => {
    const bytes = Buffer.from('%PDF-1.7\nprova sintetica per il test');
    signFiles.mockResolvedValue(new Map([['private/rights.pdf', 'https://storage.test/rights']]));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(bytes, {
          headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) },
        }),
      ),
    );

    await expect(
      inspectPrivateEvidenceFile('private/rights.pdf', 'application/pdf', bytes.length),
    ).resolves.toBeUndefined();
  });

  it('rifiuta una prova il cui contenuto non corrisponde al tipo file dichiarato', async () => {
    const bytes = Buffer.from('file non PDF');
    signFiles.mockResolvedValue(new Map([['private/rights.pdf', 'https://storage.test/rights']]));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(bytes, {
          headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) },
        }),
      ),
    );

    await expect(
      inspectPrivateEvidenceFile('private/rights.pdf', 'application/pdf', bytes.length),
    ).rejects.toBeInstanceOf(InvalidPrivateEvidenceFile);
  });
});
