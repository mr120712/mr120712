// @polsia:user-owned — «Trova creator Instagram»: SOLO admin verificati, stessa origine, limite
// 'admin.instagram-finder'. API ufficiale di Meta (vedi instagram-graph.server.ts); nulla viene salvato.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { findInstagramCreators } from '@/lib/business/instagram-finder.server';
import { instagramGraphConfig } from '@/lib/business/instagram-graph.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  InstagramFinderRequestSchema,
  InstagramFinderResponseSchema,
} from '@/lib/contracts/instagram-finder';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const privateHeaders = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' };

const failureStatus = {
  auth: 502,
  permission: 502,
  rate_limited: 503,
  hashtag_limit: 429,
  not_found: 404,
  timeout: 504,
  failed: 502,
} as const;

function failure(error: string, status: number, detail?: string) {
  return NextResponse.json(
    { error, ...(detail ? { detail } : {}) },
    { status, headers: privateHeaders },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);

  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    return failure('session_unavailable', 503);
  }
  if (!session) return failure('unauthorized', 401);
  if (!isAuthorizedAdmin(session.user)) return failure('forbidden', 403);

  const body = await readJsonLimited(request, 16 * 1024);
  if (!body.ok) return limitedJsonError(body);
  const parsed = InstagramFinderRequestSchema.safeParse(body.value);
  if (!parsed.success) return failure('invalid_request', 400);

  const config = instagramGraphConfig();
  if (!config) return failure('not_configured', 503);

  const limited = await enforceRateLimit('admin.instagram-finder', `user:${session.user.id}`);
  if (limited) {
    for (const [name, value] of Object.entries(privateHeaders)) limited.headers.set(name, value);
    return limited;
  }

  const outcome = await findInstagramCreators(parsed.data, config);
  if (!outcome.ok) return failure(outcome.error, failureStatus[outcome.error], outcome.detail);
  return NextResponse.json(InstagramFinderResponseSchema.parse(outcome.result), {
    headers: privateHeaders,
  });
}
