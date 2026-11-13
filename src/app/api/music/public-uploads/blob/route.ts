// @polsia:user-owned — rilascia un URL PUT firmato per il caricamento diretto su AWS S3.
// Solo utenti loggati, stessa origine, con rate-limit, entro il tetto per utente, solo audio.
// Il server sceglie la chiave (prefisso consentito): il client non decide dove finisce il file.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { PublicUploadPresignRequestSchema } from '@/lib/contracts/public-uploads';
import {
  buildPublicUploadKey,
  countUserPublicUploads,
  isPublicUploadConfigured,
  MAX_UPLOADS_PER_USER,
} from '@/lib/music/public-uploads.server';
import { presignUploadPut } from '@/lib/music/s3-storage.server';
import { requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const ALLOWED_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/webm',
]);

export async function POST(request: Request): Promise<Response> {
  if (!isPublicUploadConfigured()) {
    return NextResponse.json(
      {
        error: 'not_configured',
        message: 'Il caricamento non è ancora configurato sul server (AWS S3).',
      },
      { status: 503 },
    );
  }
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
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
  // Tetto per utente già qui: un utente al limite non riceve nemmeno l'URL firmato (evita oggetti
  // orfani su S3 che poi non potrebbero essere registrati).
  if ((await countUserPublicUploads(userId)) >= MAX_UPLOADS_PER_USER) {
    return NextResponse.json(
      { error: 'limit_reached', message: 'Hai raggiunto il numero massimo di brani pubblici.' },
      { status: 409 },
    );
  }

  const payload = await readJsonLimited(request, 4096);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = PublicUploadPresignRequestSchema.safeParse(payload.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Richiesta di caricamento non valida.' },
      { status: 400 },
    );
  }
  if (!ALLOWED_CONTENT_TYPES.has(parsed.data.contentType)) {
    return NextResponse.json(
      { error: 'unsupported_type', message: 'Formato audio non supportato.' },
      { status: 400 },
    );
  }

  const key = buildPublicUploadKey(
    parsed.data.title,
    parsed.data.fileName,
    parsed.data.contentType,
  );
  try {
    const uploadUrl = await presignUploadPut(key, parsed.data.contentType);
    return NextResponse.json(
      { uploadUrl, key, contentType: parsed.data.contentType },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { error: 'presign_failed', message: 'Impossibile avviare il caricamento. Riprova.' },
      { status: 502 },
    );
  }
}

/** Dice al form se la libreria pubblica è attiva (AWS S3 configurato), per un messaggio chiaro. */
export function GET() {
  return NextResponse.json(
    { configured: isPublicUploadConfigured() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
