// @polsia:user-owned — stato di un Direct Post avviato (GET ?publishId=...). Solo amministratori
// verificati. "PUBLISH_COMPLETE" significa pubblicato.
import 'server-only';
import { NextResponse } from 'next/server';
import { requireVerifiedMusicRightsAdmin } from '@/lib/music/rights-admin.server';
import {
  notConfiguredResponse,
  tiktokConfig,
  tiktokPrivateHeaders,
} from '@/lib/tiktok/config.server';
import { tiktokAccessTokenFor } from '@/lib/tiktok/connection.server';
import { tiktokErrorResponse } from '@/lib/tiktok/http.server';
import { fetchPublishStatus } from '@/lib/tiktok/publish.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;
  const config = tiktokConfig();
  if (!config) return notConfiguredResponse();

  const publishId = new URL(request.url).searchParams.get('publishId') ?? '';
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(publishId)) {
    return NextResponse.json(
      { error: 'invalid_id' },
      { status: 400, headers: tiktokPrivateHeaders },
    );
  }
  try {
    const accessToken = await tiktokAccessTokenFor(access.user.id, config);
    const status = await fetchPublishStatus(accessToken, publishId);
    return NextResponse.json(status, { headers: tiktokPrivateHeaders });
  } catch (error) {
    return tiktokErrorResponse(error);
  }
}
