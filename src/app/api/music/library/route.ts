// @polsia:user-owned — Libreria personale: lettura e modifiche (radio, podcast, cartelle, cronologia).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  LibraryMutationResponseSchema,
  LibraryMutationSchema,
  LibraryResponseSchema,
} from '@/lib/contracts/library';
import { applyLibraryMutation, getLibrary, LibraryError } from '@/lib/music/library.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

async function signedIn(request: Request): Promise<{ user: SessionUser } | { response: Response }> {
  try {
    return { user: await requireAuth(request) };
  } catch (response) {
    return { response: response as Response };
  }
}

export async function GET(request: Request) {
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;
  try {
    const library = await getLibrary(auth.user.id);
    return NextResponse.json(LibraryResponseSchema.parse(library), { headers: privateHeaders });
  } catch {
    return NextResponse.json(
      { error: 'library_unavailable' },
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
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;
  const limited = await enforceRateLimit('library.write', `user:${auth.user.id}`);
  if (limited) return limited;
  const payload = await readJsonLimited(request, 8 * 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = LibraryMutationSchema.safeParse(payload.value);
  if (!body.success) {
    return NextResponse.json(
      { errors: { body: 'Controlla i dati della Libreria.' } },
      { status: 400, headers: privateHeaders },
    );
  }
  try {
    await applyLibraryMutation(auth.user.id, body.data);
    // Recording a play is fire-and-forget from the player: skip re-reading the library.
    const library = body.data.action === 'record_play' ? undefined : await getLibrary(auth.user.id);
    return NextResponse.json(LibraryMutationResponseSchema.parse({ ok: true, library }), {
      headers: privateHeaders,
    });
  } catch (error) {
    if (error instanceof LibraryError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.code === 'not_found' ? 404 : 409, headers: privateHeaders },
      );
    }
    return NextResponse.json(
      { error: 'library_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
