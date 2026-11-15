// @polsia:user-owned — libreria pubblica SPENTA (src/lib/features.ts): /pubblica rimanda alla Home,
// niente voce nel menu, nella sitemap e in llms.txt, le API della libreria rispondono 404 PRIMA di
// sessione, origine e limiti (una funzione spenta non costa nulla), il testo degli upload è null e
// il player non lo chiede. L'elenco privato, la rimozione e il download dei PROPRI brani restano
// all'autore. /pubblica ha anche un vero 307 HTTP nei redirect di next.user-config.ts.
// L'interruttore è simulato con vi.mock; un test controlla anche il valore reale spedito (false).
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  /** Stato dell'interruttore simulato: spento come in produzione, acceso solo dove serve. */
  featureOn: false,
  requireAuth: vi.fn(),
  getSessionUser: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  consumeRateLimit: vi.fn(),
  readJsonLimited: vi.fn(),
  premium: vi.fn(),
  networkIdentity: vi.fn(),
  handleUpload: vi.fn(),
  readFeatured: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  server: {
    listPublicUploads: vi.fn(),
    registerPublicUpload: vi.fn(),
    deletePublicUpload: vi.fn(),
    updatePublicUploadLyrics: vi.fn(),
    reportPublicUpload: vi.fn(),
    recordPublicUploadPlay: vi.fn(),
    listMyPublicUploads: vi.fn(),
    countUserPublicUploads: vi.fn(),
    isPublicUploadConfigured: vi.fn(),
    getOwnUploadForDownload: vi.fn(),
    readPublishedUploadLyrics: vi.fn(),
  },
}));

vi.mock('@/lib/features', () => ({ publicUploadsEnabled: () => mocks.featureOn }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/components/custom/music/public-library-view', () => ({
  PublicLibraryView: () => null,
}));
vi.mock('@/lib/env', () => ({
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test', NEXT_PUBLIC_APP_URL: 'https://solco.test' },
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: mocks.requireAuth,
  getSessionUser: mocks.getSessionUser,
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  consumeRateLimit: mocks.consumeRateLimit,
  rateLimitResponse: () => new Response('limited', { status: 429 }),
}));
vi.mock('@/lib/business/request-body.server', () => ({
  readJsonLimited: mocks.readJsonLimited,
  limitedJsonError: () => new Response('too large', { status: 413 }),
}));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
vi.mock('@/lib/business/auth-guards.server', () => ({ networkIdentity: mocks.networkIdentity }));
vi.mock('@vercel/blob/client', () => ({ handleUpload: mocks.handleUpload }));
vi.mock('@/lib/music/featured-lyrics.server', () => ({ readFeaturedLyrics: mocks.readFeatured }));
vi.mock('@/lib/music/public-uploads.server', () => {
  class PublicUploadLimitReached extends Error {}
  class InvalidPublicUploadSource extends Error {}
  class BlobNotConfigured extends Error {}
  return {
    ...mocks.server,
    MAX_UPLOADS_PER_USER: 3,
    PUBLIC_UPLOAD_PREFIX: 'public-uploads/',
    PublicUploadLimitReached,
    InvalidPublicUploadSource,
    BlobNotConfigured,
  };
});

import PublicUploadsPage from '@/app/(custom)/pubblica/page';
import { GET as LYRICS } from '@/app/api/music/lyrics/route';
import { GET as DOWNLOAD } from '@/app/api/music/public-uploads/[uploadId]/download/route';
import { POST as PLAY } from '@/app/api/music/public-uploads/[uploadId]/play/route';
import { POST as REPORT } from '@/app/api/music/public-uploads/[uploadId]/report/route';
import { DELETE, PATCH } from '@/app/api/music/public-uploads/[uploadId]/route';
import { GET as BLOB_GET, POST as BLOB_POST } from '@/app/api/music/public-uploads/blob/route';
import { GET as MINE } from '@/app/api/music/public-uploads/mine/route';
import { POST as CREATE, GET as LIST } from '@/app/api/music/public-uploads/route';
import sitemap from '@/app/sitemap';
import { lyricsTargetFor } from '@/components/custom/music/lyrics-target';
import { renderLlmsTxt } from '@/lib/llms';
import { llmsConfig } from '@/lib/llms-config';
import { navItems } from '@/lib/nav';
import { userNextConfig } from '../../next.user-config';

const ID = 'c'.repeat(25);
const ORIGIN = 'https://solco.test';
const params = (uploadId = ID) => ({ params: Promise.resolve({ uploadId }) });

function request(path: string, method = 'GET', body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Nessun controllo è partito prima del cancello: niente sessione, origine, limiti, corpo, dati. */
function expectNothingRan() {
  expect(mocks.requireAuth).not.toHaveBeenCalled();
  expect(mocks.getSessionUser).not.toHaveBeenCalled();
  expect(mocks.sameOrigin).not.toHaveBeenCalled();
  expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  expect(mocks.readJsonLimited).not.toHaveBeenCalled();
  expect(mocks.premium).not.toHaveBeenCalled();
  expect(mocks.handleUpload).not.toHaveBeenCalled();
  for (const fn of Object.values(mocks.server)) expect(fn).not.toHaveBeenCalled();
}

async function expectNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toEqual({ error: 'not_found' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.featureOn = false;
  // Se un cancello mancasse, queste risposte lascerebbero proseguire la route (e il test fallirebbe
  // sui "not.toHaveBeenCalled"), invece di fermarla per un motivo diverso.
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.getSessionUser.mockResolvedValue({ id: 'user-1' });
  mocks.sameOrigin.mockReturnValue(true);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.readJsonLimited.mockResolvedValue({ ok: true, value: {} });
  mocks.premium.mockResolvedValue(true);
  mocks.server.isPublicUploadConfigured.mockReturnValue(true);
});

afterEach(() => vi.unstubAllGlobals());

describe('interruttore della libreria pubblica', () => {
  it('nel codice spedito è spento (disattivata su richiesta)', async () => {
    const actual = await vi.importActual<typeof import('@/lib/features')>('@/lib/features');
    expect(actual.publicUploadsEnabled()).toBe(false);
  });
});

describe('/pubblica con la libreria spenta', () => {
  it('rimanda alla Home', () => {
    expect(() => PublicUploadsPage()).toThrow('NEXT_REDIRECT:/');
    expect(mocks.redirect).toHaveBeenCalledWith('/');
  });

  it('con la libreria accesa mostra la pagina, senza rimandi', () => {
    mocks.featureOn = true;
    expect(PublicUploadsPage()).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  // Il redirect() della pagina resta nello stream RSC (risposta 200): il 307 vero lo dà la config.
  it('redirect HTTP 307 (non permanente) da /pubblica alla Home nella config di Next', async () => {
    const rules = (await userNextConfig.redirects?.()) ?? [];
    expect(rules).toContainEqual({ source: '/pubblica', destination: '/', permanent: false });
    // I redirect del sottodominio di stato restano.
    expect(rules.filter((rule) => rule.destination === '/stato')).toHaveLength(2);
  });

  it('con la libreria accesa la config non rimanda più /pubblica', async () => {
    mocks.featureOn = true;
    const rules = (await userNextConfig.redirects?.()) ?? [];
    expect(rules.some((rule) => rule.source === '/pubblica')).toBe(false);
    expect(rules).toHaveLength(2);
  });
});

describe('menu, sitemap e llms.txt con la libreria spenta', () => {
  it('nessuna voce /pubblica nel menu', () => {
    expect(navItems.some((item) => item.href === '/pubblica')).toBe(false);
    // Il resto del menu resta com'era.
    expect(navItems.some((item) => item.href === '/library')).toBe(true);
    expect(navItems.some((item) => item.href === '/community')).toBe(true);
  });

  it('nessun /pubblica nella sitemap', async () => {
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls.some((url) => url.endsWith('/pubblica'))).toBe(false);
    // Controllo positivo: le pagine pubbliche ci sono (la Libreria è dietro il login: fuori sitemap).
    expect(urls.some((url) => url.endsWith('/guida'))).toBe(true);
  });

  it('nessun /pubblica in llms.txt', async () => {
    const text = await renderLlmsTxt(llmsConfig);
    expect(text).not.toContain('/pubblica');
    expect(text).toContain('/guida');
  });

  it('con la libreria accesa la voce torna, nella stessa posizione del menu', async () => {
    mocks.featureOn = true;
    vi.resetModules();
    const { navItems: enabledItems } = await import('@/lib/nav');
    const item = enabledItems.find((entry) => entry.href === '/pubblica');
    expect(item).toEqual({ label: 'Pubblica', href: '/pubblica', group: 'primary', order: 3 });
    const hrefs = enabledItems.map((entry) => entry.href);
    expect(hrefs.indexOf('/pubblica')).toBe(hrefs.indexOf('/classici') + 1);
    expect(enabledItems).toHaveLength(navItems.length + 1);
  });
});

describe('API della libreria pubblica spenta: 404 prima di ogni controllo', () => {
  it('GET elenco', async () => {
    await expectNotFound(await LIST());
    expectNothingRan();
  });

  it('POST registrazione', async () => {
    await expectNotFound(await CREATE(request('/api/music/public-uploads', 'POST', {})));
    expectNothingRan();
  });

  it('GET stato del caricamento (blob)', async () => {
    await expectNotFound(BLOB_GET());
    expectNothingRan();
  });

  it('POST token di caricamento (blob)', async () => {
    const body = {
      type: 'blob.generate-client-token',
      payload: { pathname: 'public-uploads/x.mp3' },
    };
    await expectNotFound(await BLOB_POST(request('/api/music/public-uploads/blob', 'POST', body)));
    expectNothingRan();
  });

  it('POST callback di completamento di Vercel Blob', async () => {
    const body = { type: 'blob.upload-completed', payload: { blob: {}, tokenPayload: '{}' } };
    await expectNotFound(await BLOB_POST(request('/api/music/public-uploads/blob', 'POST', body)));
    expectNothingRan();
  });

  it('PATCH testo del proprio brano', async () => {
    const body = { lyrics: 'Testo', lyricsRightsConfirmed: true };
    await expectNotFound(
      await PATCH(request(`/api/music/public-uploads/${ID}`, 'PATCH', body), params()),
    );
    expectNothingRan();
  });

  it('POST ascolto (classifica)', async () => {
    await expectNotFound(
      await PLAY(request(`/api/music/public-uploads/${ID}/play`, 'POST'), params()),
    );
    expectNothingRan();
    expect(mocks.networkIdentity).not.toHaveBeenCalled();
  });

  it('POST segnalazione', async () => {
    await expectNotFound(
      await REPORT(request(`/api/music/public-uploads/${ID}/report`, 'POST'), params()),
    );
    expectNothingRan();
  });

  it('con la libreria accesa le stesse route tornano a controllare sessione e origine', async () => {
    mocks.featureOn = true;
    mocks.sameOrigin.mockReturnValue(false);
    expect((await CREATE(request('/api/music/public-uploads', 'POST', {}))).status).toBe(403);
    expect(
      (await REPORT(request(`/api/music/public-uploads/${ID}/report`, 'POST'), params())).status,
    ).toBe(403);
    expect(mocks.sameOrigin).toHaveBeenCalledTimes(2);
  });
});

describe('i propri brani restano all’autore anche con la libreria spenta', () => {
  it('GET i miei brani: 200, solo i tuoi, privato e mai in cache', async () => {
    const item = {
      id: ID,
      title: 'La mia canzone',
      artist: null,
      streamUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/brano-x.mp3',
      durationSeconds: 180,
      playCount: 0,
      createdAt: '2026-11-01T10:00:00.000Z',
      mine: true,
      published: true,
      canPlay: true,
    };
    mocks.server.listMyPublicUploads.mockResolvedValue([item]);
    const response = await MINE(request('/api/music/public-uploads/mine'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ items: [item] });
    expect(mocks.requireAuth).toHaveBeenCalled();
    expect(mocks.server.listMyPublicUploads).toHaveBeenCalledWith('user-1');
  });

  it('GET i miei brani senza accesso: 401, nessuna lettura', async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Response(null, { status: 401 }));
    const response = await MINE(request('/api/music/public-uploads/mine'));
    expect(response.status).toBe(401);
    expect(mocks.server.listMyPublicUploads).not.toHaveBeenCalled();
  });

  it('DELETE del proprio brano: 200, rimosso (oggetto su Blob compreso)', async () => {
    mocks.server.deletePublicUpload.mockResolvedValue(true);
    const response = await DELETE(request(`/api/music/public-uploads/${ID}`, 'DELETE'), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.sameOrigin).toHaveBeenCalled();
    expect(mocks.requireAuth).toHaveBeenCalled();
    expect(mocks.server.deletePublicUpload).toHaveBeenCalledWith('user-1', ID);
  });

  it('DELETE resta protetto: altra origine 403, brano altrui 404', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect(
      (await DELETE(request(`/api/music/public-uploads/${ID}`, 'DELETE'), params())).status,
    ).toBe(403);
    mocks.server.deletePublicUpload.mockResolvedValue(false);
    expect(
      (await DELETE(request(`/api/music/public-uploads/${ID}`, 'DELETE'), params())).status,
    ).toBe(404);
  });

  it('download del proprio file: 200 come allegato', async () => {
    mocks.server.getOwnUploadForDownload.mockResolvedValue({
      blobUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/brano-x.mp3',
      blobPathname: 'public-uploads/brano-x.mp3',
      title: 'La mia canzone',
      mimeType: 'audio/mpeg',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('AUDIO', { headers: { 'content-type': 'audio/mpeg' } })),
    );
    const response = await DOWNLOAD(request(`/api/music/public-uploads/${ID}/download`), params());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(await response.text()).toBe('AUDIO');
    expect(mocks.server.getOwnUploadForDownload).toHaveBeenCalledWith('user-1', ID);
  });

  it('download di un file non tuo: 404', async () => {
    mocks.server.getOwnUploadForDownload.mockResolvedValue(null);
    const response = await DOWNLOAD(request(`/api/music/public-uploads/${ID}/download`), params());
    expect(response.status).toBe(404);
  });
});

describe('testo dei brani caricati con la libreria spenta', () => {
  it('GET /api/music/lyrics?upload=<id>: { lyrics: null }, senza limite né lettura', async () => {
    const response = await LYRICS(request(`/api/music/lyrics?upload=${ID}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ lyrics: null });
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.server.readPublishedUploadLyrics).not.toHaveBeenCalled();
  });

  it('il testo dei brani in evidenza resta disponibile', async () => {
    mocks.readFeatured.mockResolvedValue(null);
    const response = await LYRICS(request('/api/music/lyrics?featured=Pop%2FA%20-%20B.mp3'));
    expect(response.status).toBe(200);
    expect(mocks.readFeatured).toHaveBeenCalledWith('Pop/A - B.mp3');
  });

  it('il player non offre il testo di un upload:<id> rimasto in coda', () => {
    const upload = {
      qualifiedId: `upload:${ID}`,
      playbackMode: 'upload' as const,
      sourceLabel: 'Libreria pubblica',
      sourceUrl: null,
    };
    expect(lyricsTargetFor(upload)).toBeNull();
    // I brani in evidenza non cambiano.
    expect(lyricsTargetFor({ ...upload, qualifiedId: 'upload:Pop/A - B.mp3' })).toEqual({
      source: 'featured',
      id: 'Pop/A - B.mp3',
    });
    mocks.featureOn = true;
    expect(lyricsTargetFor(upload)).toEqual({ source: 'upload', id: ID });
  });
});
