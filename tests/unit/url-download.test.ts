// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  apiKey: 'audius-key' as string,
  resolve: vi.fn(async (_url?: string) => ({ data: { id: 'trk-1' } }) as unknown),
  fetchBounded: vi.fn(),
  resolveAudius: vi.fn(),
  downloadAudius: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: { publicUpload: { findFirst: mocks.findFirst } },
}));
vi.mock('@/lib/music/audius-api.server', () => ({
  readAudiusApiKey: () => mocks.apiKey,
  createAudiusApiClient: () => ({ resolve: mocks.resolve }),
}));
vi.mock('@/lib/music/offline-download.server', () => ({
  fetchBoundedAudio: mocks.fetchBounded,
  resolveAudiusDownload: mocks.resolveAudius,
  downloadAudiusAudio: mocks.downloadAudius,
}));

import { downloadFromUrl } from '@/lib/music/url-download.server';

const BLOB = 'https://store123.public.blob.vercel-storage.com/public-uploads/abc.mp3';
const AUDIUS = 'https://audius.co/artista/brano-abc';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiKey = 'audius-key';
  mocks.findFirst.mockResolvedValue(null);
  mocks.resolve.mockResolvedValue({ data: { id: 'trk-1' } });
  mocks.fetchBounded.mockResolvedValue({
    ok: true,
    bytes: new Uint8Array([1, 2, 3]),
    contentType: 'audio/mpeg',
  });
  mocks.resolveAudius.mockResolvedValue({
    ok: true,
    title: 'Brano',
    artist: 'Artista',
    sourceUrl: 'https://audius.co/x',
    durationSeconds: 100,
    attribution: {},
  });
  mocks.downloadAudius.mockResolvedValue({
    ok: true,
    bytes: new Uint8Array([9]),
    contentType: 'audio/mpeg',
  });
});

describe('downloadFromUrl — allowlist & SSRF', () => {
  it('rifiuta un URL non https', async () => {
    const r = await downloadFromUrl('http://store123.public.blob.vercel-storage.com/x.mp3', 'u1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_url');
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it('rifiuta un host arbitrario (es. YouTube): niente DB, niente Audius', async () => {
    const r = await downloadFromUrl('https://www.youtube.com/watch?v=abc', 'u1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toBe('source_not_allowed');
    }
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('URL Blob NON di proprietà: rifiutato (no IDOR), nessun fetch', async () => {
    mocks.findFirst.mockResolvedValue(null); // non è un upload di questo utente
    const r = await downloadFromUrl(BLOB, 'u1');
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { blobUrl: BLOB, uploaderUserId: 'u1' },
      select: { blobUrl: true, blobPathname: true, title: true, mimeType: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('source_not_allowed');
    expect(mocks.fetchBounded).not.toHaveBeenCalled();
  });

  it('URL Blob di proprietà: scarica e nomina dal titolo', async () => {
    mocks.findFirst.mockResolvedValue({
      blobUrl: BLOB,
      blobPathname: 'public-uploads/abc.mp3',
      title: 'La mia canzone',
      mimeType: 'audio/mpeg',
    });
    const r = await downloadFromUrl(BLOB, 'u1');
    expect(mocks.fetchBounded).toHaveBeenCalledWith(BLOB);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filename).toBe('La mia canzone.mp3');
      expect(r.mimeType).toBe('audio/mpeg');
      expect(r.bytes).toEqual(new Uint8Array([1, 2, 3]));
    }
  });

  it('URL Blob con query/hash: confronta solo origine+percorso', async () => {
    mocks.findFirst.mockResolvedValue({
      blobUrl: BLOB,
      blobPathname: 'public-uploads/abc.mp3',
      title: 'X',
      mimeType: 'audio/mpeg',
    });
    await downloadFromUrl(`${BLOB}?download=1#frag`, 'u1');
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { blobUrl: BLOB, uploaderUserId: 'u1' } }),
    );
  });

  it('upload troppo grande: 413', async () => {
    mocks.findFirst.mockResolvedValue({
      blobUrl: BLOB,
      blobPathname: 'public-uploads/abc.mp3',
      title: 'X',
      mimeType: 'audio/mpeg',
    });
    mocks.fetchBounded.mockResolvedValue({ ok: false, reason: 'too_large' });
    const r = await downloadFromUrl(BLOB, 'u1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  it('URL Audius scaricabile: risolve, riverifica e scarica', async () => {
    const r = await downloadFromUrl(AUDIUS, 'u1');
    expect(mocks.resolve).toHaveBeenCalled();
    expect(mocks.resolveAudius).toHaveBeenCalledWith('trk-1', expect.anything());
    expect(mocks.downloadAudius).toHaveBeenCalledWith('trk-1', expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filename).toBe('Brano.mp3');
  });

  it('URL Audius ma brano non scaricabile: 403 not_downloadable, nessun download', async () => {
    mocks.resolveAudius.mockResolvedValue({ ok: false, reason: 'not_downloadable' });
    const r = await downloadFromUrl(AUDIUS, 'u1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toBe('not_downloadable');
    }
    expect(mocks.downloadAudius).not.toHaveBeenCalled();
  });

  it('URL Audius ma resolve non trova un brano: 404', async () => {
    mocks.resolve.mockResolvedValue({ data: null });
    const r = await downloadFromUrl(AUDIUS, 'u1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
    expect(mocks.resolveAudius).not.toHaveBeenCalled();
  });

  it('URL Audius ma Audius non configurato: 503', async () => {
    mocks.apiKey = '';
    const r = await downloadFromUrl(AUDIUS, 'u1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('resolve che lancia: 404, non propaga', async () => {
    mocks.resolve.mockRejectedValue(new Error('boom'));
    const r = await downloadFromUrl(AUDIUS, 'u1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('rifiuta un URL malformato', async () => {
    const r = await downloadFromUrl('not a url', 'u1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_url');
  });

  it('rifiuta un URL con credenziali', async () => {
    const r = await downloadFromUrl('https://user:pass@audius.co/x', 'u1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_url');
  });
});
