// @polsia:user-owned — rilascia il token per il caricamento diretto su Vercel Blob (client upload).
// Solo utenti loggati, solo audio, entro il limite di dimensione, e solo nel prefisso consentito.
import 'server-only';
import { type HandleUploadBody, handleUpload } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { MAX_PUBLIC_UPLOAD_BYTES } from '@/lib/contracts/public-uploads';
import {
  countUserPublicUploads,
  isPublicUploadConfigured,
  MAX_UPLOADS_PER_USER,
  PUBLIC_UPLOAD_PREFIX,
} from '@/lib/music/public-uploads.server';
import { requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const ALLOWED_CONTENT_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/webm',
];

export async function POST(request: Request): Promise<Response> {
  if (!isPublicUploadConfigured()) {
    return NextResponse.json(
      {
        error: 'not_configured',
        message: 'Il caricamento non è ancora configurato sul server (Vercel Blob).',
      },
      { status: 503 },
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // La richiesta del token parte dal browser dell'utente: va protetta (stessa origine + login +
  // rate-limit). La callback di completamento è server-to-server da Vercel Blob (nessun Origin né
  // cookie) e viene verificata dalla firma dentro handleUpload: NON applicarle quei controlli,
  // altrimenti il caricamento non si conclude.
  let userId = '';
  if ((body as { type?: string } | null)?.type === 'blob.generate-client-token') {
    if (!sameOrigin(request)) {
      return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
    }
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch (response) {
      return response as Response;
    }
    const limited = await enforceRateLimit('recordings.write', `user:${userId}`);
    if (limited) return limited;
    // Tetto per utente già qui: un utente al limite non riceve nemmeno il token (evita di creare
    // oggetti pubblici che poi non potrebbero essere registrati).
    if ((await countUserPublicUploads(userId)) >= MAX_UPLOADS_PER_USER) {
      return NextResponse.json(
        { error: 'limit_reached', message: 'Hai raggiunto il numero massimo di brani pubblici.' },
        { status: 409 },
      );
    }
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(PUBLIC_UPLOAD_PREFIX)) {
          throw new Error('Percorso non consentito.');
        }
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_PUBLIC_UPLOAD_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId }),
        };
      },
      // Il salvataggio dei metadati avviene con una POST autenticata separata (register), quindi
      // qui non serve fare nulla alla fine del caricamento.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: 'upload_rejected', message: (error as Error).message },
      { status: 400 },
    );
  }
}

/** Dice al form se la libreria pubblica è attiva (Vercel Blob configurato), per un messaggio chiaro. */
export function GET() {
  return NextResponse.json(
    { configured: isPublicUploadConfigured() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
