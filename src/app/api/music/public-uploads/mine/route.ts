// @polsia:user-owned — i brani pubblici caricati dall'utente (anche quelli ritirati dalla
// moderazione), per gestirli: elenco e rimozione.
import 'server-only';
import { NextResponse } from 'next/server';
import { PublicUploadMineResponseSchema } from '@/lib/contracts/public-uploads';
import { listMyPublicUploads } from '@/lib/music/public-uploads.server';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

export async function GET(request: Request) {
  let userId: string;
  try {
    const user = await requireAuth(request);
    userId = user.id;
  } catch (response) {
    return response as Response;
  }
  try {
    const items = await listMyPublicUploads(userId);
    return NextResponse.json(PublicUploadMineResponseSchema.parse({ items }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: 'uploads_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
