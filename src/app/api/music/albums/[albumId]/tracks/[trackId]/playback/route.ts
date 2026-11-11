// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { requireSolcoPro } from '@/lib/business/solco-pro-entitlement';
import { checkCurrentAudiusTrack } from '@/lib/music/current-catalog-track.server';
import { isVerifiedTrackPlayback } from '@/lib/music/playback-policy';
import { resolveVerifiedTrackPlayback } from '@/lib/music/streaming-rights.server';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Vary: 'Cookie',
};

function denied(reason: string, status: number) {
  return NextResponse.json({ allowed: false, reason }, { status, headers: privateHeaders });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ albumId: string; trackId: string }> },
) {
  const { albumId, trackId } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(albumId) || !/^[A-Za-z0-9_-]{1,128}$/.test(trackId)) {
    return denied('track_unavailable', 404);
  }

  const access = await requireSolcoPro(request);
  if (!access.allowed) {
    const status = access.response.status;
    return denied(
      status === 401 ? 'unauthorized' : status === 403 ? 'pro_required' : 'entitlement_unavailable',
      status,
    );
  }

  const catalog = await checkCurrentAudiusTrack(albumId, trackId);
  if (catalog.state === 'unavailable') return denied('catalog_unavailable', 503);
  if (catalog.state !== 'current') return denied('track_unavailable', 404);

  try {
    const resolution = await resolveVerifiedTrackPlayback(albumId, trackId);
    if (!isVerifiedTrackPlayback(resolution, albumId, trackId)) {
      return denied('rights_unverified', 403);
    }
    const [sourceAvailable, evidenceAvailable] = await Promise.all([
      resolution.checkSourceAvailable(),
      resolution.checkRightsEvidenceAvailable(),
    ]);
    return sourceAvailable && evidenceAvailable
      ? NextResponse.json({ allowed: true }, { headers: privateHeaders })
      : denied('rights_unverified', 403);
  } catch {
    return denied('rights_unavailable', 503);
  }
}
