// @polsia:user-owned — "Salva nella mia libreria": copia una playlist condivisa in una nuova
// playlist dell'account (stessi brani, stesso ordine, stesso tetto di 100 playlist).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { availableCollectionName } from '@/lib/business/track-list-import.server';
import { SaveSharedPlaylistResponseSchema } from '@/lib/contracts/shared-playlist';
import { prisma } from '@/lib/db';
import { MAX_ITEMS_PER_COLLECTION, MAX_PLAYLISTS_PER_USER } from '@/lib/music/collections.server';
import { isShareId } from '@/lib/music/playlist-share';
import { findSharedCollection } from '@/lib/music/shared-playlists.server';
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

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function notShared() {
  return NextResponse.json(
    { error: 'not_found', message: 'Questa playlist non è più condivisa.' },
    { status: 404, headers: privateHeaders },
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;
  const userId = auth.user.id;
  const { shareId } = await params;
  if (!isShareId(shareId)) return notShared();
  const limited = await enforceRateLimit('library.write', `user:${userId}`);
  if (limited) return limited;
  // No fields are needed: the body is only bounded, never trusted.
  const payload = await readJsonLimited(request, 512);
  if (!payload.ok && payload.status === 413) return limitedJsonError(payload);

  try {
    const shared = await findSharedCollection(shareId);
    if (!shared) return notShared();
    // The owner opening their own link: a copy would only be a "name (2)" duplicate.
    if (shared.userId === userId) {
      return NextResponse.json(
        { error: 'own_playlist', message: 'Questa playlist è già nella tua Libreria.' },
        { status: 409, headers: privateHeaders },
      );
    }

    const playlists = await prisma.userMusicCollection.count({
      where: { userId, kind: 'playlist' },
    });
    if (playlists >= MAX_PLAYLISTS_PER_USER) {
      return NextResponse.json(
        {
          error: 'limit_reached',
          message: `Hai raggiunto il limite di ${MAX_PLAYLISTS_PER_USER} playlist. Eliminane una per salvarne una nuova.`,
        },
        { status: 409, headers: privateHeaders },
      );
    }

    // Same order as the shared list (newest first): decreasing timestamps keep it. YouTube
    // metadata keeps its own expiry (never extended); expired metadata is already removed.
    const now = Date.now();
    const items = shared.items.slice(0, MAX_ITEMS_PER_COLLECTION).map((item, index) => ({
      source: item.source,
      sourceId: item.sourceId,
      title: item.title,
      creatorName: item.creatorName,
      artworkUrl: item.artworkUrl,
      sourceUrl: item.sourceUrl,
      artistUrl: item.artistUrl,
      durationSeconds: item.durationSeconds,
      expiresAt: item.expiresAt,
      createdAt: new Date(now - index),
    }));

    for (let attempt = 0; ; attempt += 1) {
      const name = await availableCollectionName(userId, shared.name);
      try {
        const collection = await prisma.userMusicCollection.create({
          data: { userId, name, kind: 'playlist', items: { create: items } },
          select: { id: true },
        });
        return NextResponse.json(
          SaveSharedPlaylistResponseSchema.parse({ collectionId: collection.id, name }),
          { status: 201, headers: privateHeaders },
        );
      } catch (error) {
        // Another save or import took the same name in the meantime: pick the next free one.
        if (attempt < 2 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  } catch {
    return NextResponse.json(
      { error: 'save_unavailable', message: 'Non è stato possibile salvare la playlist. Riprova.' },
      { status: 503, headers: privateHeaders },
    );
  }
}
