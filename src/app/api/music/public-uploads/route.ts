// @polsia:user-owned — libreria pubblica dei brani caricati: GET elenco (pubblico), POST registra
// (loggato) un brano già salvato su Vercel Blob.
import 'server-only';
import { NextResponse } from 'next/server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  PublicUploadCreateResponseSchema,
  PublicUploadCreateSchema,
  PublicUploadListResponseSchema,
} from '@/lib/contracts/public-uploads';
import {
  InvalidPublicUploadSource,
  listPublicUploads,
  PublicUploadLimitReached,
  registerPublicUpload,
  StorageNotConfigured,
} from '@/lib/music/public-uploads.server';
import { getSessionUser, requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

export async function GET() {
  try {
    const viewer = await getSessionUser();
    const items = await listPublicUploads(viewer?.id ?? null);
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
  const payload = await readJsonLimited(request, 4096);
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
        { errors: { key: 'Il file caricato non è un audio valido.' } },
        { status: 400, headers: privateHeaders },
      );
    }
    if (error instanceof StorageNotConfigured) {
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
