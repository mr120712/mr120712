// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { ListeningEntryResponseSchema, UpdateListeningEntrySchema } from '@/lib/contracts/music';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// Note (2,000 characters), rating, date and context; leaves room for multi-byte text.
const MAX_BODY_BYTES = 16 * 1024;

function serializeEntry(entry: {
  id: string;
  albumId: string;
  catalogProvider: string;
  albumName: string;
  artistName: string;
  artworkUrl: string | null;
  releaseDate: string | null;
  genre: string | null;
  trackCount: number | null;
  storeUrl: string | null;
  rating: number;
  note: string;
  listenedOn: Date;
  context: string | null;
  createdAt: Date;
}) {
  return {
    id: entry.id,
    albumId: entry.albumId,
    catalogProvider: entry.catalogProvider,
    albumName: entry.albumName,
    artistName: entry.artistName,
    artworkUrl: null,
    releaseDate: entry.releaseDate,
    genre: entry.genre,
    trackCount: entry.trackCount,
    storeUrl: entry.storeUrl,
    rating: entry.rating,
    note: entry.note,
    listenedOn: entry.listenedOn.toISOString().slice(0, 10),
    context: entry.context,
    createdAt: entry.createdAt.toISOString(),
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ entryId: string }> },
) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'Origine della richiesta non valida.' }, { status: 403 });
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  const { entryId } = await params;
  const payload = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = UpdateListeningEntrySchema.safeParse(payload.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Controlla i campi da aggiornare.' }, { status: 400 });
  }

  const limited = await enforceRateLimit(
    'listening.write',
    getRateLimitIdentity(user.id, request.headers),
  );
  if (limited) return limited;

  const data = {
    ...parsed.data,
    ...(parsed.data.context !== undefined ? { context: parsed.data.context?.trim() || null } : {}),
    ...(parsed.data.listenedOn
      ? { listenedOn: new Date(`${parsed.data.listenedOn}T12:00:00.000Z`) }
      : {}),
  };

  try {
    const updated = await prisma.listeningEntry.updateMany({
      where: { id: entryId, userId: user.id },
      data,
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: 'Ascolto non trovato.' }, { status: 404 });
    }

    const entry = await prisma.listeningEntry.findFirst({
      where: { id: entryId, userId: user.id },
    });
    if (!entry) return NextResponse.json({ error: 'Ascolto non trovato.' }, { status: 404 });
    return NextResponse.json(ListeningEntryResponseSchema.parse({ entry: serializeEntry(entry) }));
  } catch {
    return NextResponse.json(
      { error: 'Non è stato possibile aggiornare l’ascolto.' },
      { status: 500 },
    );
  }
}
