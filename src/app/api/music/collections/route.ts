// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  CollectionMutationResponseSchema,
  CollectionMutationSchema,
  MusicCollectionsSchema,
} from '@/lib/contracts/music';
import { prisma } from '@/lib/db';
import {
  ensureFavoritesCollection,
  getUserMusicCollections,
  isFavoritesName,
  MAX_ITEMS_PER_COLLECTION,
  MAX_PLAYLISTS_PER_USER,
  MusicCollectionError,
  resolveCollectionItem,
} from '@/lib/music/collections.server';
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
  const collections = await getUserMusicCollections(auth.user.id);
  return NextResponse.json(MusicCollectionsSchema.parse({ collections }), {
    headers: privateHeaders,
  });
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
  // Ogni aggiunta interroga YouTube/Audius: limite per utente prima di leggere il corpo.
  const limited = await enforceRateLimit('library.write', `user:${auth.user.id}`);
  if (limited) return limited;
  const payload = await readJsonLimited(request, 4 * 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = CollectionMutationSchema.safeParse(payload.value);
  if (!body.success) {
    return NextResponse.json(
      { errors: { body: 'Controlla i dati della raccolta.' } },
      { status: 400, headers: privateHeaders },
    );
  }

  const userId = auth.user.id;
  const action = body.data;
  try {
    if (action.action === 'create_playlist') {
      if (isFavoritesName(action.name)) {
        return NextResponse.json(
          { error: 'reserved_name' },
          { status: 409, headers: privateHeaders },
        );
      }
      const existing = await prisma.userMusicCollection.findFirst({
        where: { userId, name: action.name },
      });
      if (existing)
        return NextResponse.json(
          { error: 'duplicate_name' },
          { status: 409, headers: privateHeaders },
        );
      const playlistCount = await prisma.userMusicCollection.count({
        where: { userId, kind: 'playlist' },
      });
      if (playlistCount >= MAX_PLAYLISTS_PER_USER) {
        return NextResponse.json(
          {
            error: 'limit_reached',
            message: `Hai raggiunto il limite di ${MAX_PLAYLISTS_PER_USER} playlist. Eliminane una per crearne una nuova.`,
          },
          { status: 409, headers: privateHeaders },
        );
      }
      await prisma.userMusicCollection.create({
        data: { userId, name: action.name, kind: 'playlist' },
      });
    } else if (action.action === 'delete_playlist') {
      const deleted = await prisma.userMusicCollection.deleteMany({
        where: { id: action.collectionId, userId, kind: 'playlist' },
      });
      if (deleted.count === 0)
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
    } else if (action.action === 'remove_item') {
      const owned = await prisma.userMusicCollectionItem.findFirst({
        where: { id: action.itemId, collectionId: action.collectionId, collection: { userId } },
        select: { id: true },
      });
      if (!owned)
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
      await prisma.userMusicCollectionItem.deleteMany({
        where: { id: owned.id, collectionId: action.collectionId, collection: { userId } },
      });
    } else {
      const collection =
        action.action === 'favorite'
          ? await ensureFavoritesCollection(userId)
          : await prisma.userMusicCollection.findFirst({
              where: { id: action.collectionId, userId },
            });
      if (!collection)
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
      // Il limite si controlla prima di chiamare YouTube/Audius; aggiornare un elemento già
      // presente resta possibile anche a raccolta piena.
      const itemCount = await prisma.userMusicCollectionItem.count({
        where: { collectionId: collection.id },
      });
      if (itemCount >= MAX_ITEMS_PER_COLLECTION) {
        const alreadySaved = await prisma.userMusicCollectionItem.findUnique({
          where: {
            collectionId_source_sourceId: {
              collectionId: collection.id,
              source: action.source,
              sourceId: action.sourceId,
            },
          },
          select: { id: true },
        });
        if (!alreadySaved) {
          return NextResponse.json(
            {
              error: 'limit_reached',
              message: `${collection.kind === 'favorites' ? 'I Preferiti hanno' : 'Questa playlist ha'} raggiunto il limite di ${MAX_ITEMS_PER_COLLECTION} elementi. Rimuovine uno per aggiungerne altri.`,
            },
            { status: 409, headers: privateHeaders },
          );
        }
      }
      const metadata = await resolveCollectionItem(action.source, action.sourceId);
      await prisma.userMusicCollectionItem.upsert({
        where: {
          collectionId_source_sourceId: {
            collectionId: collection.id,
            source: action.source,
            sourceId: action.sourceId,
          },
        },
        create: { collectionId: collection.id, ...metadata },
        update: metadata,
      });
    }

    const collections = await getUserMusicCollections(userId);
    return NextResponse.json(CollectionMutationResponseSchema.parse({ collections }), {
      headers: privateHeaders,
    });
  } catch (error) {
    if (error instanceof MusicCollectionError) {
      const status =
        error.code === 'not_found' ? 404 : error.code === 'source_inactive' ? 409 : 422;
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status, headers: privateHeaders },
      );
    }
    return NextResponse.json(
      { error: 'collection_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
