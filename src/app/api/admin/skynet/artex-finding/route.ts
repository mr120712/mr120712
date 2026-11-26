// @polsia:user-owned — the ARTEX → Solco hardening loop endpoint.
//
// POST  /api/admin/skynet/artex-finding  — MACHINE endpoint. ARTEX (on the owner's VPS) reports a
//   defensive-assessment finding. Authenticated by a Bearer secret (ARTEX_FINDING_API_KEY), NOT by
//   sameOrigin: this is a cross-origin server-to-server call, it carries no cookie and no Origin, so
//   the Bearer IS the authorization. Fail-closed: no secret configured → 503, never open.
// GET   /api/admin/skynet/artex-finding  — the owner reviews findings from the admin panel
//   (verified-admin session, same gate as every other /api/admin route). Never same as the machine
//   ingest path's auth.
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { ArtexFindingInputSchema, ArtexFindingListSchema } from '@/lib/contracts/artex-finding';
import { ingestArtexFinding, listArtexFindings } from '@/lib/skynet/artex-findings.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store' };

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

/** Timing-safe Bearer check against ARTEX_FINDING_API_KEY. Fail-closed when unset/too short. */
function machineAuthorized(
  request: Request,
): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  const secret = process.env.ARTEX_FINDING_API_KEY?.trim();
  if (!secret || secret.length < 24)
    return { ok: false, status: 503, error: 'ingest_unconfigured' };
  const token = /^Bearer\s+(.+)$/i
    .exec((request.headers.get('authorization') ?? '').trim())?.[1]
    ?.trim();
  if (!token) return { ok: false, status: 401, error: 'unauthorized' };
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

export async function POST(request: Request) {
  const authed = machineAuthorized(request);
  if (!authed.ok) return fail(authed.error, authed.status);

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return fail('invalid_json', 400);
  }

  const parsed = ArtexFindingInputSchema.safeParse(json);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'body';
      if (!errors[key]) errors[key] = issue.message;
    }
    return NextResponse.json({ errors }, { status: 400, headers: privateHeaders });
  }

  try {
    const finding = await ingestArtexFinding(parsed.data);
    return NextResponse.json(
      {
        id: finding.id,
        status: finding.status,
        probeAccepted: finding.probeAccepted,
        probeRejectedReason: finding.probeRejectedReason ?? null,
      },
      { status: 201, headers: privateHeaders },
    );
  } catch {
    return fail('ingest_failed', 503);
  }
}

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return fail('unauthorized', 401);
    if (!isAuthorizedAdmin(session.user)) return fail('forbidden', 403);
  } catch {
    return fail('session_unavailable', 503);
  }

  try {
    const items = await listArtexFindings();
    const body = ArtexFindingListSchema.parse({ items });
    return NextResponse.json(body, { headers: { ...privateHeaders, Vary: 'Cookie' } });
  } catch {
    return fail('findings_unavailable', 503);
  }
}
