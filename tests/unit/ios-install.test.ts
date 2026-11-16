// @polsia:user-owned — installazione dell'app iOS dal sito: token firmati a scadenza, ispezione
// dell'IPA (identificativo, versione, firma e metodo), manifest itms-services, route pubbliche
// (stato con sessione, manifest e file solo col token), route admin (origine e corpo) e il file di
// associazione app-sito, con e senza APPLE_TEAM_ID. Niente rete: store e sessione sono finti.
// @vitest-environment node
import { crc32, deflateRawSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    BETTER_AUTH_SECRET: 's'.repeat(40),
    BLOB_READ_WRITE_TOKEN: undefined as string | undefined,
    APPLE_TEAM_ID: undefined as string | undefined,
    NEXT_PUBLIC_APP_URL: 'https://www.solcomusic.online',
  },
  get: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  list: vi.fn(),
  requireAuth: vi.fn(),
  enforceRateLimit: vi.fn(async () => null),
  sameOrigin: vi.fn(() => true),
  requireIosAdmin: vi.fn(async () => ({ allowed: true as const, userId: 'admin-1' })),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: mocks.env }));
vi.mock('@vercel/blob', () => ({
  get: mocks.get,
  put: mocks.put,
  del: mocks.del,
  list: mocks.list,
}));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: mocks.requireAuth,
  getSessionUser: vi.fn(),
}));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/admin/ios-app-access.server', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireIosAdmin: mocks.requireIosAdmin,
    iosAdminJson: (body: unknown, status = 200) => NextResponse.json(body, { status }),
    iosAdminPrivateHeaders: {},
  };
});

import { buildIosManifest, isIosIpaBlobUrl } from '@/lib/business/ios-install.server';
import {
  signIosInstallToken,
  verifyIosInstallToken,
} from '@/lib/business/ios-install-token.server';
import { inspectIpa } from '@/lib/business/ipa-archive';
import type { IosIpaRecord } from '@/lib/contracts/ios-install';
import {
  IOS_APP_BUNDLE_ID,
  IOS_APP_VERSION,
  IOS_INSTALL_TOKEN_TTL_MS,
  isIosIpaPathname,
  itmsServicesUrl,
} from '@/lib/ios-app';

const EXPECTED = { bundleId: IOS_APP_BUNDLE_ID, version: IOS_APP_VERSION };
const BLOB_URL = `https://store.private.blob.vercel-storage.com/ios-app/Solco-${IOS_APP_VERSION}-abc123.ipa`;

/** Uno zip minimo (voci "stored" o "deflate"), quanto basta per l'ispezione. */
function makeZip(entries: { name: string; data: string | Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

function infoPlist(bundleId = IOS_APP_BUNDLE_ID, version = IOS_APP_VERSION): string {
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;
}

function provisioningProfile(kind: 'ad-hoc' | 'development' | 'enterprise' | 'app-store'): string {
  const devices =
    '<key>ProvisionedDevices</key><array><string>00008030-A</string><string>00008030-B</string><string>00008030-C</string></array>';
  const taskAllow = `<key>get-task-allow</key>${kind === 'development' ? '<true/>' : '<false/>'}`;
  const entitlements = `<key>Entitlements</key><dict>${taskAllow}</dict>`;
  if (kind === 'enterprise')
    return `<plist><dict><key>ProvisionsAllDevices</key><true/>${entitlements}</dict></plist>`;
  if (kind === 'app-store') return `<plist><dict>${entitlements}</dict></plist>`;
  return `<plist><dict>${devices}${entitlements}</dict></plist>`;
}

function ipa(options: {
  kind?: 'ad-hoc' | 'development' | 'enterprise' | 'app-store';
  signed?: boolean;
  bundleId?: string;
  version?: string;
  deflate?: boolean;
}): Buffer {
  const { kind = 'ad-hoc', signed = true, deflate = false } = options;
  const entries: { name: string; data: string | Buffer; deflate?: boolean }[] = [
    {
      name: 'Payload/Solco.app/Info.plist',
      data: infoPlist(options.bundleId, options.version),
      deflate,
    },
    { name: 'Payload/Solco.app/Solco', data: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) },
  ];
  if (signed) {
    entries.push(
      {
        name: 'Payload/Solco.app/embedded.mobileprovision',
        data: provisioningProfile(kind),
        deflate,
      },
      { name: 'Payload/Solco.app/_CodeSignature/CodeResources', data: '<plist/>' },
    );
  }
  return makeZip(entries);
}

function blobStream(content: string | Buffer, extraHeaders: Record<string, string> = {}) {
  return {
    statusCode: 200,
    stream: new Blob([content]).stream(),
    headers: new Headers(extraHeaders),
    blob: { contentType: 'application/octet-stream' },
  };
}

const RECORD: IosIpaRecord = {
  version: IOS_APP_VERSION,
  bundleId: IOS_APP_BUNDLE_ID,
  pathname: `ios-app/Solco-${IOS_APP_VERSION}-abc123.ipa`,
  url: BLOB_URL,
  sizeBytes: 1234,
  uploadedAt: '2026-11-16T22:00:00.000Z',
  method: 'ad-hoc',
  devices: 3,
};

beforeEach(() => {
  mocks.env.BLOB_READ_WRITE_TOKEN = undefined;
  mocks.env.APPLE_TEAM_ID = undefined;
  mocks.get.mockReset();
  mocks.put.mockReset();
  mocks.del.mockReset();
  mocks.list.mockReset();
  mocks.requireAuth.mockReset();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.enforceRateLimit.mockClear();
});

describe('token di installazione', () => {
  it('firma, verifica, scade e rifiuta le manomissioni', () => {
    const now = 1_700_000_000_000;
    const signed = signIosInstallToken('user-1', now);
    expect(signed).not.toBeNull();
    if (!signed) return;
    expect(signed.expiresAt).toBe(now + IOS_INSTALL_TOKEN_TTL_MS);
    expect(verifyIosInstallToken(signed.token, now + 60_000)).toEqual({
      ok: true,
      claims: { userId: 'user-1', exp: signed.expiresAt },
    });
    expect(verifyIosInstallToken(signed.token, signed.expiresAt + 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
    const tampered = `${signed.token.slice(0, -1)}${signed.token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyIosInstallToken(tampered, now)).toEqual({ ok: false, reason: 'signature' });
    expect(verifyIosInstallToken('non-un-token', now)).toEqual({ ok: false, reason: 'format' });
    expect(verifyIosInstallToken(null, now)).toEqual({ ok: false, reason: 'format' });
  });

  it('senza segreto non rilascia né accetta token', () => {
    const secret = mocks.env.BETTER_AUTH_SECRET;
    mocks.env.BETTER_AUTH_SECRET = '';
    try {
      expect(signIosInstallToken('user-1')).toBeNull();
      expect(verifyIosInstallToken('a.b')).toEqual({ ok: false, reason: 'secret' });
    } finally {
      mocks.env.BETTER_AUTH_SECRET = secret;
    }
  });
});

describe("ispezione dell'IPA", () => {
  it('riconosce un IPA Ad Hoc di Solco con i dispositivi del profilo', () => {
    expect(inspectIpa(ipa({}), EXPECTED)).toEqual({
      ok: true,
      appName: 'Solco',
      bundleId: IOS_APP_BUNDLE_ID,
      version: IOS_APP_VERSION,
      method: 'ad-hoc',
      devices: 3,
    });
  });

  it('distingue sviluppo, Enterprise e App Store, anche con voci compresse', () => {
    expect(inspectIpa(ipa({ kind: 'development', deflate: true }), EXPECTED)).toMatchObject({
      ok: true,
      method: 'development',
      devices: 3,
    });
    expect(inspectIpa(ipa({ kind: 'enterprise' }), EXPECTED)).toMatchObject({
      ok: true,
      method: 'enterprise',
      devices: null,
    });
    expect(inspectIpa(ipa({ kind: 'app-store' }), EXPECTED)).toMatchObject({
      ok: true,
      method: 'app-store',
      devices: null,
    });
  });

  it("rifiuta un IPA senza firma, di un'altra app, di un'altra versione o che non è uno zip", () => {
    expect(inspectIpa(ipa({ signed: false }), EXPECTED)).toMatchObject({
      ok: false,
      error: 'unsigned',
    });
    expect(inspectIpa(ipa({ bundleId: 'com.other.app' }), EXPECTED)).toMatchObject({
      ok: false,
      error: 'bundle_id',
    });
    expect(inspectIpa(ipa({ version: '0.9.0' }), EXPECTED)).toMatchObject({
      ok: false,
      error: 'version',
    });
    expect(inspectIpa(Buffer.from('non uno zip'), EXPECTED)).toMatchObject({
      ok: false,
      error: 'not_zip',
    });
    expect(inspectIpa(makeZip([{ name: 'README.txt', data: 'ciao' }]), EXPECTED)).toMatchObject({
      ok: false,
      error: 'no_app',
    });
  });
});

describe('manifest e percorsi', () => {
  it('il manifest indica IPA, icone, identificativo e versione, con gli URL protetti', () => {
    const manifest = buildIosManifest({
      ipaUrl: 'https://www.solcomusic.online/api/ios/ipa?t=a.b&x=<1>',
      bundleId: IOS_APP_BUNDLE_ID,
      version: IOS_APP_VERSION,
      iconUrl: 'https://www.solcomusic.online/apple-touch-icon.png',
      fullSizeIconUrl: 'https://www.solcomusic.online/solco-icon-512.png',
    });
    expect(manifest).toContain('<string>software-package</string>');
    expect(manifest).toContain('/api/ios/ipa?t=a.b&amp;x=&lt;1&gt;</string>');
    expect(manifest).toContain(`<string>${IOS_APP_BUNDLE_ID}</string>`);
    expect(manifest).toContain(`<string>${IOS_APP_VERSION}</string>`);
    expect(manifest).toContain('<string>Solco</string>');
  });

  it('accetta solo percorsi .ipa sotto ios-app/ e URL dello store di Solco', () => {
    expect(isIosIpaPathname('ios-app/Solco-1.3.0.ipa')).toBe(true);
    expect(isIosIpaPathname('ios-app/../altro.ipa')).toBe(false);
    expect(isIosIpaPathname('audio/Solco.ipa')).toBe(false);
    expect(isIosIpaPathname('ios-app/Solco.zip')).toBe(false);
    expect(isIosIpaBlobUrl(BLOB_URL)).toBe(true);
    expect(isIosIpaBlobUrl('https://evil.example/ios-app/Solco.ipa')).toBe(false);
    expect(isIosIpaBlobUrl('https://store.public.blob.vercel-storage.com/audio/x.ipa')).toBe(false);
    expect(itmsServicesUrl('https://www.solcomusic.online/api/ios/manifest?t=a.b')).toBe(
      'itms-services://?action=download-manifest&url=https%3A%2F%2Fwww.solcomusic.online%2Fapi%2Fios%2Fmanifest%3Ft%3Da.b',
    );
  });
});

describe('GET /api/ios/install', () => {
  it('richiede la sessione', async () => {
    mocks.requireAuth.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const { GET } = await import('@/app/api/ios/install/route');
    const response = await GET(new Request('https://www.solcomusic.online/api/ios/install'));
    expect(response.status).toBe(401);
  });

  it('senza store o senza IPA dice perché non è disponibile', async () => {
    mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
    const { GET } = await import('@/app/api/ios/install/route');
    const first = await (
      await GET(new Request('https://www.solcomusic.online/api/ios/install'))
    ).json();
    expect(first).toMatchObject({
      available: false,
      reason: 'not_configured',
      bundleId: IOS_APP_BUNDLE_ID,
      installUrl: null,
    });
    mocks.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test';
    mocks.get.mockResolvedValueOnce(null);
    const second = await (
      await GET(new Request('https://www.solcomusic.online/api/ios/install'))
    ).json();
    expect(second).toMatchObject({ available: false, reason: 'none' });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('ios.install.link', 'user:user-1');
  });

  it("con un IPA Ad Hoc attivo rilascia il link itms-services con il token dell'account", async () => {
    mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
    mocks.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test';
    mocks.get.mockResolvedValueOnce(blobStream(JSON.stringify(RECORD)));
    const { GET } = await import('@/app/api/ios/install/route');
    const response = await GET(new Request('https://www.solcomusic.online/api/ios/install'));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toMatchObject({ available: true, version: IOS_APP_VERSION, method: 'ad-hoc' });
    expect(body.installUrl).toMatch(/^itms-services:\/\/\?action=download-manifest&url=/);
    const manifestUrl = decodeURIComponent(body.installUrl.split('&url=')[1]);
    expect(manifestUrl).toMatch(/^https:\/\/www\.solcomusic\.online\/api\/ios\/manifest\?t=/);
    const token = new URL(manifestUrl).searchParams.get('t');
    expect(verifyIosInstallToken(token)).toMatchObject({ ok: true, claims: { userId: 'user-1' } });
  });

  it("un IPA firmato per l'App Store non è installabile da link", async () => {
    mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
    mocks.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test';
    mocks.get.mockResolvedValueOnce(
      blobStream(JSON.stringify({ ...RECORD, method: 'app-store', devices: null })),
    );
    const { GET } = await import('@/app/api/ios/install/route');
    const body = await (
      await GET(new Request('https://www.solcomusic.online/api/ios/install'))
    ).json();
    expect(body).toMatchObject({ available: false, reason: 'method', installUrl: null });
  });
});

describe('manifest e IPA col token', () => {
  it('senza token valido rispondono 403 e non toccano lo store', async () => {
    const manifest = await import('@/app/api/ios/manifest/route');
    const file = await import('@/app/api/ios/ipa/route');
    const bad = 'https://www.solcomusic.online/api/ios/manifest?t=abc.def';
    expect((await manifest.GET(new Request(bad))).status).toBe(403);
    expect((await file.GET(new Request(bad.replace('manifest', 'ipa')))).status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('col token servono il manifest (plist) e il file dallo store privato', async () => {
    mocks.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test';
    const signed = signIosInstallToken('user-1');
    if (!signed) throw new Error('token non firmato');
    const query = `?t=${encodeURIComponent(signed.token)}`;
    mocks.get.mockResolvedValueOnce(blobStream(JSON.stringify(RECORD)));
    const manifest = await import('@/app/api/ios/manifest/route');
    const response = await manifest.GET(
      new Request(`https://www.solcomusic.online/api/ios/manifest${query}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/xml');
    const plist = await response.text();
    expect(plist).toContain(
      `https://www.solcomusic.online/api/ios/ipa?t=${encodeURIComponent(signed.token)}`,
    );
    expect(plist).toContain(`<string>${IOS_APP_BUNDLE_ID}</string>`);

    mocks.get
      .mockResolvedValueOnce(blobStream(JSON.stringify(RECORD)))
      .mockResolvedValueOnce(blobStream(Buffer.from('PK...'), { 'content-length': '5' }));
    const file = await import('@/app/api/ios/ipa/route');
    const download = await file.GET(
      new Request(`https://www.solcomusic.online/api/ios/ipa${query}`),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('content-disposition')).toBe(
      `attachment; filename="Solco-${IOS_APP_VERSION}.ipa"`,
    );
    expect(download.headers.get('content-length')).toBe('5');
    expect(await download.text()).toBe('PK...');
    expect(mocks.get).toHaveBeenLastCalledWith(
      BLOB_URL,
      expect.objectContaining({ access: 'private' }),
    );
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('ios.ipa.download', 'user:user-1');
  });
});

describe('API admin', () => {
  it('GET riporta store, IPA attivo e valori attesi; POST e DELETE vogliono la stessa origine', async () => {
    const route = await import('@/app/api/admin/ios-app/route');
    const status = await (
      await route.GET(new Request('https://www.solcomusic.online/api/admin/ios-app'))
    ).json();
    expect(status).toEqual({
      configured: false,
      current: null,
      expectedBundleId: IOS_APP_BUNDLE_ID,
      expectedVersion: IOS_APP_VERSION,
    });
    mocks.sameOrigin.mockReturnValue(false);
    const post = await route.POST(
      new Request('https://www.solcomusic.online/api/admin/ios-app', {
        method: 'POST',
        body: JSON.stringify({ blobUrl: BLOB_URL, size: 10 }),
      }),
    );
    expect(post.status).toBe(403);
    const remove = await route.DELETE(
      new Request('https://www.solcomusic.online/api/admin/ios-app', { method: 'DELETE' }),
    );
    expect(remove.status).toBe(403);
  });

  it('POST attiva solo un IPA di Solco letto dallo store e cancella quello precedente', async () => {
    mocks.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test';
    const previous = { ...RECORD, url: BLOB_URL.replace('abc123', 'old999') };
    const good = ipa({});
    mocks.get
      .mockResolvedValueOnce(blobStream(good))
      .mockResolvedValueOnce(blobStream(JSON.stringify(previous)));
    mocks.put.mockResolvedValue({ url: 'https://store/ios-app/current.json' });
    mocks.del.mockResolvedValue(undefined);
    const route = await import('@/app/api/admin/ios-app/route');
    const response = await route.POST(
      new Request('https://www.solcomusic.online/api/admin/ios-app', {
        method: 'POST',
        body: JSON.stringify({ blobUrl: BLOB_URL, size: good.length }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.current).toMatchObject({
      version: IOS_APP_VERSION,
      bundleId: IOS_APP_BUNDLE_ID,
      url: BLOB_URL,
      method: 'ad-hoc',
      devices: 3,
      sizeBytes: good.length,
    });
    expect(mocks.put).toHaveBeenCalledWith(
      'ios-app/current.json',
      expect.any(String),
      expect.objectContaining({ access: 'private', allowOverwrite: true }),
    );
    expect(mocks.del).toHaveBeenCalledWith([previous.url], expect.anything());

    mocks.get.mockResolvedValueOnce(blobStream(ipa({ signed: false })));
    const refused = await route.POST(
      new Request('https://www.solcomusic.online/api/admin/ios-app', {
        method: 'POST',
        body: JSON.stringify({ blobUrl: BLOB_URL, size: 10 }),
      }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'unsigned' });
    expect(mocks.del).toHaveBeenLastCalledWith([BLOB_URL], expect.anything());
  });
});

describe('/.well-known/apple-app-site-association', () => {
  it('risponde 404 senza APPLE_TEAM_ID e il JSON di associazione con il team', async () => {
    const { GET } = await import('@/app/.well-known/apple-app-site-association/route');
    expect(GET().status).toBe(404);
    mocks.env.APPLE_TEAM_ID = 'ABCDE12345';
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      applinks: { details: [] },
      webcredentials: { apps: [`ABCDE12345.${IOS_APP_BUNDLE_ID}`] },
    });
  });
});
