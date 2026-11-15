// @polsia:user-owned — «Non mi interessa» sui brani consigliati (e il suo «Annulla»): salva o toglie
// il brano dall'elenco personale dei nascosti (RecommendationHidden, al massimo 300 per utente).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  RecommendationFeedbackResponseSchema,
  RecommendationFeedbackSchema,
} from '@/lib/contracts/recommendations';
import { hideRecommendation, unhideRecommendation } from '@/lib/music/recommendations.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: privateHeaders });
  }
  const limited = await enforceRateLimit('music.recommendations.feedback', `user:${user.id}`);
  if (limited) return limited;

  const payload = await readJsonLimited(request, 2 * 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = RecommendationFeedbackSchema.safeParse(payload.value);
  if (!body.success) {
    return NextResponse.json(
      { errors: { itemKey: 'Brano non valido.' } },
      { status: 400, headers: privateHeaders },
    );
  }

  try {
    if (body.data.kind === 'hide') {
      await hideRecommendation(user.id, body.data.itemKey);
    } else {
      await unhideRecommendation(user.id, body.data.itemKey);
    }
    return NextResponse.json(RecommendationFeedbackResponseSchema.parse({ ok: true }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: 'recommendations_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
