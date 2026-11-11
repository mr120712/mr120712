// @polsia:user-owned — premi Solco: riepilogo e azioni (invito, ascolto, compleanno).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { normalizeBirthday } from '@/lib/business/rewards';
import {
  claimReferral,
  evaluateRewards,
  getRewardsSummary,
  recordListening,
  setBirthday,
} from '@/lib/business/rewards.server';
import { RewardsActionSchema, RewardsSummarySchema } from '@/lib/contracts/rewards';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const REF_COOKIE = 'solco_ref';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

async function signedIn(request: Request): Promise<{ user: SessionUser } | { response: Response }> {
  try {
    return { user: await requireAuth(request) };
  } catch (response) {
    return { response: response as Response };
  }
}

function readCookie(request: Request, name: string) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function GET(request: Request) {
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;
  try {
    const summary = await getRewardsSummary(auth.user.id);
    return NextResponse.json(RewardsSummarySchema.parse(summary), { headers: privateHeaders });
  } catch {
    return NextResponse.json(
      { error: 'rewards_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;
  const limited = await enforceRateLimit('library.write', `user:${auth.user.id}`);
  if (limited) return limited;
  const payload = await readJsonLimited(request, 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = RewardsActionSchema.safeParse(payload.value);
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400, headers: privateHeaders });
  }
  const userId = auth.user.id;
  try {
    if (body.data.action === 'claim_referral') {
      const code = readCookie(request, REF_COOKIE);
      const result = code ? await claimReferral(userId, code) : 'invalid_code';
      const response = NextResponse.json({ result }, { headers: privateHeaders });
      response.cookies.set(REF_COOKIE, '', { path: '/', maxAge: 0 });
      return response;
    }
    if (body.data.action === 'listen') {
      const counted = await recordListening(userId, body.data.seconds);
      if (counted) await evaluateRewards(userId);
      return NextResponse.json({ counted }, { headers: privateHeaders });
    }
    const birthday = normalizeBirthday(body.data.birthday);
    if (!birthday) {
      return NextResponse.json(
        { error: 'invalid_birthday', message: 'Inserisci giorno e mese validi.' },
        { status: 400, headers: privateHeaders },
      );
    }
    const saved = await setBirthday(userId, birthday);
    if (!saved) {
      return NextResponse.json(
        { error: 'birthday_locked', message: 'La data di compleanno è già impostata.' },
        { status: 409, headers: privateHeaders },
      );
    }
    await evaluateRewards(userId);
    return NextResponse.json({ saved: true }, { headers: privateHeaders });
  } catch {
    return NextResponse.json(
      { error: 'rewards_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
