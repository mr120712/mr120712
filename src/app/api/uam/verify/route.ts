// @polsia:user-owned
//
// POST /api/uam/verify — the UAM loading screen posts its proof of work here.
// A valid, fresh challenge bound to this client (ipPrefix + UA hash) plus a
// correct solution earns the `solco_uam` clearance cookie. No DB and no rate
// limit: the proof of work is the throttle.
import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readJsonLimited } from '@/lib/business/request-body.server';
import { sameOrigin } from '@/lib/same-origin';
import {
  ipPrefix,
  issueClearance,
  readUamConfig,
  UAM_COOKIE,
  type UamContext,
  uaHash,
  vercelDeploymentOrigins,
  verifyChallenge,
  verifySolution,
} from '@/lib/security/uam';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 1024;

const VerifyBody = z.object({
  challenge: z.string().max(200),
  solution: z.string().regex(/^\d{1,12}$/),
});

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Secure when the public request is https (platform header first, then the URL). */
function isHttps(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded === 'https') return true;
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * sameOrigin, plus this Vercel deployment's own origins (preview, branch and
 * production URLs), so the loading screen also works on previews. The gate only
 * challenges on hosts this accepts (uamChallengeHosts in src/lib/security/uam.ts).
 */
function trustedOrigin(request: Request): boolean {
  if (sameOrigin(request)) return true;
  const origin = request.headers.get('origin');
  return origin !== null && vercelDeploymentOrigins(process.env).includes(origin);
}

export async function POST(request: Request) {
  if (!trustedOrigin(request)) {
    return json({ error: 'forbidden_origin' }, 403);
  }

  const config = readUamConfig(process.env);
  if (!config.enabled) {
    return json({ error: 'disabled' }, 503);
  }

  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return json({ error: body.error }, body.status);
  }
  const parsed = VerifyBody.safeParse(body.value);
  if (!parsed.success) {
    return json({ error: 'bad_request' }, 400);
  }
  const { challenge, solution } = parsed.data;

  const ctx: UamContext = {
    secret: config.secret,
    ipPrefix: ipPrefix(request.headers.get('x-real-ip')),
    uaHash: await uaHash(request.headers.get('user-agent')),
  };

  const check = await verifyChallenge(challenge, ctx);
  if (!check.ok) {
    return json({ error: check.error }, 400);
  }
  // Issued before the mode/difficulty went up: ask for a fresh, harder challenge.
  if (check.difficulty < config.difficulty) {
    return json({ error: 'expired' }, 400);
  }
  if (!(await verifySolution(challenge, solution, check.difficulty))) {
    return json({ error: 'wrong_solution' }, 400);
  }

  const response = json({ ok: true }, 200);
  response.cookies.set(
    UAM_COOKIE,
    await issueClearance(ctx, config.mode, config.clearanceTtlSeconds),
    {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: isHttps(request),
      maxAge: config.clearanceTtlSeconds,
    },
  );
  return response;
}
