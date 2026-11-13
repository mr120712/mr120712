// @polsia:user-owned — pubblica un video annunciato su TikTok (Content Posting, Direct Post).
// GET: info del creator (opzioni di privacy, limiti) — obbligatorie prima di pubblicare.
// POST: avvia il Direct Post con PULL_FROM_URL. Solo amministratori verificati, stessa origine,
// con limite di frequenza. Il token resta sul server; nessun segreto nel corpo.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { TikTokPublishRequestSchema } from '@/lib/contracts/tiktok-connect';
import { requireVerifiedMusicRightsAdmin } from '@/lib/music/rights-admin.server';
import { sameOrigin } from '@/lib/same-origin';
import {
  notConfiguredResponse,
  tiktokConfig,
  tiktokPrivateHeaders,
} from '@/lib/tiktok/config.server';
import { tiktokAccessTokenFor } from '@/lib/tiktok/connection.server';
import { tiktokErrorResponse } from '@/lib/tiktok/http.server';
import { initDirectPost, queryCreatorInfo } from '@/lib/tiktok/publish.server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;
  const config = tiktokConfig();
  if (!config) return notConfiguredResponse();
  try {
    const accessToken = await tiktokAccessTokenFor(access.user.id, config);
    const info = await queryCreatorInfo(accessToken);
    return NextResponse.json(info, { headers: tiktokPrivateHeaders });
  } catch (error) {
    return tiktokErrorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: tiktokPrivateHeaders },
    );
  }
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;
  const config = tiktokConfig();
  if (!config) return notConfiguredResponse();

  const limited = await enforceRateLimit(
    'tiktok.publish.admin',
    getRateLimitIdentity(access.user.id, request.headers),
  );
  if (limited) return limited;
  const globallyLimited = await enforceRateLimit('tiktok.publish.global', 'global');
  if (globallyLimited) return globallyLimited;

  const payload = await readJsonLimited(request, 8 * 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = TikTokPublishRequestSchema.safeParse(payload.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = typeof issue?.path[0] === 'string' ? issue.path[0] : 'videoUrl';
    return NextResponse.json(
      { errors: { [field]: issue?.message ?? 'Dati non validi.' } },
      { status: 400, headers: tiktokPrivateHeaders },
    );
  }

  try {
    const accessToken = await tiktokAccessTokenFor(access.user.id, config);
    const publishId = await initDirectPost(accessToken, {
      title: parsed.data.caption,
      privacyLevel: parsed.data.privacyLevel,
      videoUrl: parsed.data.videoUrl,
      disableComment: parsed.data.disableComment,
      disableDuet: parsed.data.disableDuet,
      disableStitch: parsed.data.disableStitch,
    });
    return NextResponse.json({ publishId }, { headers: tiktokPrivateHeaders });
  } catch (error) {
    return tiktokErrorResponse(error);
  }
}
