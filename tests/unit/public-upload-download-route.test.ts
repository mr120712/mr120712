// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), getOwn: vi.fn() }));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/music/public-uploads.server', () => ({ getOwnUploadForDownload: mocks.getOwn }));

import { GET } from '@/app/api/music/public-uploads/[uploadId]/download/route';

const ID = 'c'.repeat(25);
const req = () => new Request(`https://solco.test/api/music/public-uploads/${ID}/download`);
const params = (id = ID) => ({ params: Promise.resolve({ uploadId: id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.getOwn.mockResolvedValue({
    blobUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/brano-x.mp3',
    blobPathname: 'public-uploads/brano-x.mp3',
    title: 'La mia canzone',
    mimeType: 'audio/mpeg',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('AUDIO', {
          headers: { 'content-type': 'audio/mpeg', 'content-length': '5' },
        }),
    ),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/music/public-uploads/[id]/download', () => {
  it('401 se non autenticato', async () => {
    mocks.requireAuth.mockRejectedValue(new Response('no', { status: 401 }));
    expect((await GET(req(), params())).status).toBe(401);
    expect(mocks.getOwn).not.toHaveBeenCalled();
  });

  it('404 su id malformato (senza nemmeno interrogare il DB)', async () => {
    const res = await GET(req(), params('BAD!'));
    expect(res.status).toBe(404);
    expect(mocks.getOwn).not.toHaveBeenCalled();
  });

  it('404 se il brano non è dell’utente (o non esiste)', async () => {
    mocks.getOwn.mockResolvedValue(null);
    expect((await GET(req(), params())).status).toBe(404);
    expect(mocks.getOwn).toHaveBeenCalledWith('user-1', ID);
  });

  it('200: allega il file con nome leggibile e ne streamma il contenuto', async () => {
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain('attachment');
    expect(cd).toContain('.mp3');
    expect(cd).toContain("filename*=UTF-8''");
    expect(await res.text()).toBe('AUDIO');
  });

  it('502 se l’oggetto su Blob non è recuperabile', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect((await GET(req(), params())).status).toBe(502);
  });
});
