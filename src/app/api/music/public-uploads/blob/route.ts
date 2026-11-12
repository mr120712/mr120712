// @polsia:user-owned — rilascia il token per il caricamento diretto su Vercel Blob (client upload).
// Solo utenti loggati, solo audio, entro il limite di dimensione, e solo nel prefisso consentito.
import 'server-only';
import { type HandleUploadBody, handleUpload } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { MAX_PUBLIC_UPLOAD_BYTES } from '@/lib/contracts/public-uploads';
import { isPublicUploadConfigured, PUBLIC_UPLOAD_PREFIX } from '@/lib/music/public-uploads.server';
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
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  if (!isPublicUploadConfigured()) {
    return NextResponse.json(
      {
        error: 'not_configured',
        message: 'Il caricamento non è ancora configurato sul server (Vercel Blob).',
      },
      { status: 503 },
    );
  }

  let userId: string;
  try {
    const user = await requireAuth(request);
    userId = user.id;
  } catch (response) {
    return response as Response;
  }

  const limited = await enforceRateLimit('recordings.write', `user:${userId}`);
  if (limited) return limited;

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
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
