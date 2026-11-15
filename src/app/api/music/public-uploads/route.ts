// @polsia:user-owned — libreria pubblica dei brani caricati: GET elenco (pubblico), POST registra
// (loggato) un brano già salvato su Vercel Blob, con il testo facoltativo (solo con la conferma
// dei diritti sul testo: senza, 400 sul campo lyricsRightsConfirmed). Con la libreria pubblica
// spenta (src/lib/features.ts) entrambe rispondono 404, prima di ogni altro controllo.
import 'server-only';
import { NextResponse } from 'next/server';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  PublicUploadCreateResponseSchema,
  PublicUploadCreateSchema,
  PublicUploadListResponseSchema,
} from '@/lib/contracts/public-uploads';
import {
  BlobNotConfigured,
  InvalidPublicUploadSource,
  listPublicUploads,
  PublicUploadLimitReached,
  registerPublicUpload,
} from '@/lib/music/public-uploads.server';
import { publicUploadsDisabledResponse } from '@/lib/music/public-uploads-gate.server';
import { getSessionUser, requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

/** Corpo massimo della registrazione: metadati + testo (UTF-8, a capo e spazi compresi). */
const CREATE_BODY_MAX_BYTES = 160 * 1024;

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

export async function GET() {
  const disabled = publicUploadsDisabledResponse();
  if (disabled) return disabled;
  try {
    const viewer = await getSessionUser();
    // Solo i Premium (e il proprietario sui propri brani) ricevono lo streamUrl per ascoltare.
    const premium = viewer ? await hasPremiumAccess(viewer.id) : false;
    const items = await listPublicUploads(viewer?.id ?? null, premium);
    return NextResponse.json(PublicUploadListResponseSchema.parse({ items }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: 'uploads_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}

export async function POST(request: Request) {
  const disabled = publicUploadsDisabledResponse();
  if (disabled) return disabled;
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

  // Niente rate-limit qui: il caricamento vero (e il suo tetto) è già limitato al rilascio del
  // token in /blob. Caricare due volte lo stesso oggetto fallisce comunque (blobUrl unico).
  // Metadati (pochi byte) più il testo facoltativo (al massimo 20 000 caratteri normalizzati).
  const payload = await readJsonLimited(request, CREATE_BODY_MAX_BYTES);
  if (!payload.ok) return limitedJsonError(payload);

  const parsed = PublicUploadCreateSchema.safeParse(payload.value);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string' && !errors[field]) errors[field] = issue.message;
    }
    return NextResponse.json({ errors }, { status: 400, headers: privateHeaders });
  }

  try {
    const upload = await registerPublicUpload(userId, parsed.data);
    return NextResponse.json(PublicUploadCreateResponseSchema.parse({ upload }), {
      status: 201,
      headers: privateHeaders,
    });
  } catch (error) {
    if (error instanceof PublicUploadLimitReached) {
      return NextResponse.json(
        { error: 'limit_reached', message: 'Hai raggiunto il numero massimo di brani pubblici.' },
        { status: 409, headers: privateHeaders },
      );
    }
    if (error instanceof InvalidPublicUploadSource) {
      return NextResponse.json(
        { errors: { blobUrl: 'Il file caricato non è un audio valido.' } },
        { status: 400, headers: privateHeaders },
      );
    }
    if (error instanceof BlobNotConfigured) {
      return NextResponse.json(
        { error: 'not_configured', message: 'Caricamento non configurato sul server.' },
        { status: 503, headers: privateHeaders },
      );
    }
    return NextResponse.json(
      { error: 'uploads_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
