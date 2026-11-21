// @polsia:user-owned — GET /api/admin/featured-rights: accesso solo per admin con email verificata
// (401/403/503, senza toccare lo store), risposta privata non memorizzabile e validata dal
// contratto, nessun testo dei brani nel JSON (marcatori unici nei file .lrc e nei tag), 500 con
// messaggio generico se la diagnosi fallisce o contiene un campo non previsto.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  override: null as null | (() => Promise<unknown>),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({ env: { BLOB_READ_WRITE_TOKEN: 'tok_test' } }));
vi.mock('@/lib/admin/featured-rights-report.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/featured-rights-report.server')>();
  return {
    ...actual,
    buildFeaturedRightsReport: (...args: Parameters<typeof actual.buildFeaturedRightsReport>) =>
      mocks.override ? mocks.override() : actual.buildFeaturedRightsReport(...args),
  };
});

import { GET } from '@/app/api/admin/featured-rights/route';
import { clearFeaturedRightsReportCacheForTests } from '@/lib/admin/featured-rights-report.server';
import { AdminFeaturedRightsSchema } from '@/lib/contracts/admin-featured-rights';
import { clearFeaturedLyricsCacheForTests } from '@/lib/music/featured-lyrics.server';
import { clearFeaturedSearchCacheForTests } from '@/lib/music/featured-search.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const MARKER = 'TESTO-SEGRETO-4e8b1d';
const encoder = new TextEncoder();
const admin = { id: 'admin-1', role: 'admin', email: 'bestmr12@icloud.com', emailVerified: true };

type StoreFile = { pathname: string; bytes: Uint8Array };

function syncsafe(value: number): number[] {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}

function mp3WithUslt(lyrics: string): Uint8Array {
  const data = new Uint8Array([3, ...encoder.encode('ita'), 0, ...encoder.encode(lyrics)]);
  const frame = new Uint8Array(10 + data.length);
  frame.set(encoder.encode('USLT'), 0);
  frame[7] = data.length & 0xff;
  frame[6] = (data.length >>> 8) & 0xff;
  frame.set(data, 10);
  const header = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(frame.length)]);
  const mpeg = new Uint8Array(417 * 8);
  for (let index = 0; index < 8; index += 1) mpeg.set([0xff, 0xfb, 0x90, 0x64], index * 417);
  const out = new Uint8Array(header.length + frame.length + mpeg.length);
  out.set(header, 0);
  out.set(frame, header.length);
  out.set(mpeg, header.length + frame.length);
  return out;
}

const store: StoreFile[] = [
  { pathname: 'Cantautori/Autrice - Canzone.mp3', bytes: mp3WithUslt('x') },
  {
    pathname: 'Cantautori/Autrice - Canzone.lrc',
    bytes: encoder.encode(`[00:01.00]${MARKER} uno\n[00:03.00]${MARKER} due`),
  },
  { pathname: 'Rock/Band - Inno.mp3', bytes: mp3WithUslt(`${MARKER} incorporato`) },
  {
    pathname: 'diritti.json',
    bytes: encoder.encode(
      JSON.stringify({
        versione: 1,
        brani: [
          {
            file: 'Cantautori/Autrice - Canzone.mp3',
            licenza: 'propria',
            titolare: 'Autrice',
            testo: true,
          },
          { file: 'Rock/Band - Inno.mp3', licenza: 'propria', titolare: 'Band', testo: true },
        ],
      }),
    ),
  },
];

function request() {
  return new Request('https://solco.test/api/admin/featured-rights', {
    headers: { cookie: 'better-auth.session_token=fake' },
  });
}

function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

let errors: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.override = null;
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clearFeaturedRightsReportCacheForTests();
  clearFeaturedSearchCacheForTests();
  clearFeaturedLyricsCacheForTests();
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.list.mockImplementation(async () => ({
    blobs: store.map((file) => ({
      pathname: file.pathname,
      url: `${PRIVATE}/${file.pathname.split('/').map(encodeURIComponent).join('/')}`,
      downloadUrl: '',
      size: file.bytes.length,
      uploadedAt: new Date('2026-11-01T00:00:00Z'),
    })),
    hasMore: false,
  }));
  mocks.get.mockImplementation(async (path: string) => {
    const pathname = path.split('/').map(decodeURIComponent).join('/');
    const file = store.find((item) => item.pathname === pathname);
    if (!file) return null;
    return {
      statusCode: 200,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(file.bytes);
          controller.close();
        },
      }),
      headers: new Headers({ 'content-length': String(file.bytes.length) }),
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/admin/featured-rights: accesso', () => {
  it('401 senza sessione, senza toccare lo store', async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('403 per un utente che non è admin o per un admin con email non verificata', async () => {
    for (const user of [
      { id: 'u1', role: 'user', emailVerified: true },
      { id: 'u2', role: null, emailVerified: true },
      { ...admin, emailVerified: false },
    ]) {
      mocks.getSession.mockResolvedValue({ user });
      const response = await GET(request());
      expect(response.status).toBe(403);
      expectPrivate(response);
      expect(await response.json()).toEqual({ error: 'forbidden' });
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('503 se la sessione non è verificabile', async () => {
    mocks.getSession.mockRejectedValue(new Error('database giù'));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'session_unavailable' });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/featured-rights: diagnosi', () => {
  it('200 privata, nel formato del contratto, con fonte e righe ma MAI il testo', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expectPrivate(response);
    const raw = await response.text();
    expect(raw).not.toContain(MARKER);
    expect(raw).not.toContain('incorporato"');
    const body = AdminFeaturedRightsSchema.parse(JSON.parse(raw));
    expect(body.tracks.map((row) => [row.pathname, row.lyrics])).toEqual([
      ['Cantautori/Autrice - Canzone.mp3', { status: 'lrc', kind: 'synced', lineCount: 2 }],
      ['Rock/Band - Inno.mp3', { status: 'embedded', kind: 'plain', lineCount: 1 }],
    ]);
    expect(body.manifest.status).toBe('valid');
    expect(body.summary.lyricsFound).toBe(2);
  });

  it('500 con messaggio generico se la diagnosi fallisce; nei log solo il nome dell’errore', async () => {
    mocks.override = () => Promise.reject(new TypeError(`dettaglio ${MARKER}`));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expectPrivate(response);
    const body = await response.json();
    expect(body).toEqual({
      error: 'featured_rights_unavailable',
      message:
        'La diagnosi di diritti e testi non è disponibile in questo momento. Riprova tra poco.',
    });
    expect(errors).toHaveBeenCalledWith(
      '[admin/featured-rights] diagnosi non riuscita:',
      'TypeError',
    );
    expect(JSON.stringify(errors.mock.calls)).not.toContain(MARKER);
  });

  it('500 se la diagnosi contiene un campo non previsto (per esempio le righe del testo)', async () => {
    const { buildFeaturedRightsReport } = await vi.importActual<
      typeof import('@/lib/admin/featured-rights-report.server')
    >('@/lib/admin/featured-rights-report.server');
    const real = await buildFeaturedRightsReport();
    const first = real.tracks[0];
    if (!first) throw new Error('Diagnosi vuota.');
    mocks.override = async () => ({
      ...real,
      tracks: [{ ...first, lyrics: { ...first.lyrics, lines: [MARKER] } }],
    });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(MARKER);
  });
});
