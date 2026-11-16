// @polsia:user-owned — il file IPA per l'installatore di iOS, letto dallo store privato e
// ritrasmesso solo con un token valido (parametro `t`, lo stesso del manifest). Limite per account
// del token, risposta mai in cache condivisa.
import 'server-only';
import { NextResponse } from 'next/server';
import {
  isInstallableMethod,
  openIosIpa,
  readIosIpaRecord,
} from '@/lib/business/ios-install.server';
import { verifyIosInstallToken } from '@/lib/business/ios-install-token.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';

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
  const file = await openIosIpa(record);
  if (!file) return new NextResponse(null, { status: 404, headers: NO_STORE });
  const headers = new Headers({
    ...NO_STORE,
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="Solco-${record.version}.ipa"`,
    'x-content-type-options': 'nosniff',
  });
  if (file.contentLength) headers.set('content-length', file.contentLength);
  return new Response(file.stream, { status: 200, headers });
}
