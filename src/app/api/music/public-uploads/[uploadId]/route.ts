// @polsia:user-owned — rimozione di un brano pubblico (solo il suo autore). Cancella anche
// l'oggetto su Vercel Blob.
import 'server-only';
import { NextResponse } from 'next/server';
import { deletePublicUpload } from '@/lib/music/public-uploads.server';
import { requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

const idPattern = /^[a-z0-9]{20,40}$/;

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  let userId: string;
  try {
    const user = await requireAuth(request);
    userId = user.id;
  } catch (response) {
    return response as Response;
  }

  const { uploadId } = await params;
  if (!idPattern.test(uploadId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
  }

  try {
    const removed = await deletePublicUpload(userId, uploadId);
    if (!removed) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
    }
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch {
    return NextResponse.json(
      { error: 'uploads_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
