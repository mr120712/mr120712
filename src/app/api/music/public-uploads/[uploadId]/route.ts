// @polsia:user-owned — un brano pubblico dell'utente: DELETE lo rimuove (cancella anche l'oggetto
// su Vercel Blob), PATCH aggiunge, cambia o toglie il suo TESTO. Solo il suo autore.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  PublicUploadCreateResponseSchema,
  PublicUploadLyricsUpdateSchema,
} from '@/lib/contracts/public-uploads';
import { deletePublicUpload, updatePublicUploadLyrics } from '@/lib/music/public-uploads.server';
import { requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

const idPattern = /^[a-z0-9]{20,40}$/;

/** Corpo massimo della modifica del testo (al massimo 20 000 caratteri normalizzati). */
const LYRICS_BODY_MAX_BYTES = 160 * 1024;

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

/**
 * Testo di un brano dell'utente: { lyrics: string | null, lyricsRightsConfirmed: boolean }. Un
 * testo non vuoto richiede la conferma dei diritti (400 sul campo, come alla creazione); null o
 * vuoto toglie il testo. 404 se il brano non esiste o non è dell'utente (stessa risposta).
 */
export async function PATCH(
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

  const limited = await enforceRateLimit('library.write', `user:${userId}`);
  if (limited) return limited;

  const payload = await readJsonLimited(request, LYRICS_BODY_MAX_BYTES);
  if (!payload.ok) return limitedJsonError(payload);

  const parsed = PublicUploadLyricsUpdateSchema.safeParse(payload.value);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      const key = typeof field === 'string' ? field : 'lyrics';
      if (!errors[key]) errors[key] = issue.message;
    }
    return NextResponse.json({ errors }, { status: 400, headers: privateHeaders });
  }

  try {
    const upload = await updatePublicUploadLyrics(userId, uploadId, parsed.data);
    if (!upload) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
    }
    return NextResponse.json(PublicUploadCreateResponseSchema.parse({ upload }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: 'uploads_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
