// @polsia:user-owned — il manifest plist che l'installatore di iOS legge dal link itms-services. Non
// arriva con i cookie di Safari: il cancello è il token firmato nel parametro `t` (rilasciato da
// GET /api/ios/install a un account), con scadenza e limite per account. Il manifest rimanda l'IPA
// alla route /api/ios/ipa con lo stesso token. Mai in cache.
import 'server-only';
import { NextResponse } from 'next/server';
import {
  buildIosManifest,
  isInstallableMethod,
  readIosIpaRecord,
} from '@/lib/business/ios-install.server';
import { verifyIosInstallToken } from '@/lib/business/ios-install-token.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { IOS_IPA_PATH } from '@/lib/ios-app';
import { siteUrl } from '@/lib/site';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'private, no-store' };

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('t');
  const check = verifyIosInstallToken(token);
  if (!check.ok) {
    return new NextResponse(null, {
      status: check.reason === 'secret' ? 503 : 403,
      headers: NO_STORE,
    });
  }
  const limited = await enforceRateLimit('ios.ipa.download', `user:${check.claims.userId}`);
  if (limited) return limited;
  const record = await readIosIpaRecord();
  if (!record || !isInstallableMethod(record.method)) {
    return new NextResponse(null, { status: 404, headers: NO_STORE });
  }
  const manifest = buildIosManifest({
    ipaUrl: `${siteUrl}${IOS_IPA_PATH}?t=${encodeURIComponent(token ?? '')}`,
    bundleId: record.bundleId,
    version: record.version,
    iconUrl: `${siteUrl}/apple-touch-icon.png`,
    fullSizeIconUrl: `${siteUrl}/solco-icon-512.png`,
  });
  return new NextResponse(manifest, {
    headers: { ...NO_STORE, 'content-type': 'application/xml; charset=utf-8' },
  });
}
