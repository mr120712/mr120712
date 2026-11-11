// @polsia:user-owned — importa una playlist pubblica YouTube nella Libreria.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  YouTubePlaylistImportResponseSchema,
  YouTubePlaylistImportSchema,
} from '@/lib/contracts/library';
import { prisma } from '@/lib/db';
import {
  isFavoritesName,
  MAX_PLAYLISTS_PER_USER,
  youtubeMetadataExpiry,
} from '@/lib/music/collections.server';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import {
  fetchYouTubePlaylist,
  parsePlaylistId,
  YouTubeImportError,
} from '@/lib/music/youtube-playlist-import.server';
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

async function availableName(userId: string, wanted: string) {
  const base = isFavoritesName(wanted) ? `${wanted} (YouTube)` : wanted;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 44)} (${attempt + 1})`;
    const existing = await prisma.userMusicCollection.findFirst({
      where: { userId, name: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  return `${base.slice(0, 40)} ${Date.now().toString(36)}`;
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
  const limited = await enforceRateLimit('library.import', `user:${auth.user.id}`);
  if (limited) return limited;
  const payload = await readJsonLimited(request, 2 * 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = YouTubePlaylistImportSchema.safeParse(payload.value);
  const playlistId = body.success ? parsePlaylistId(body.data.url) : null;
  if (!body.success || !playlistId) {
    return NextResponse.json(
      { error: 'invalid_url', message: 'Incolla il link di una playlist YouTube pubblica.' },
      { status: 400, headers: privateHeaders },
    );
  }

  // Same cap as creating a playlist by hand, checked before calling YouTube.
  const playlists = await prisma.userMusicCollection.count({
    where: { userId: auth.user.id, kind: 'playlist' },
  });
  if (playlists >= MAX_PLAYLISTS_PER_USER) {
    return NextResponse.json(
      {
        error: 'limit_reached',
        message: `Hai raggiunto il limite di ${MAX_PLAYLISTS_PER_USER} playlist. Eliminane una per importarne un'altra.`,
      },
      { status: 409, headers: privateHeaders },
    );
  }

  try {
    const playlist = await fetchYouTubePlaylist(playlistId, readYouTubeApiKey());
    const name = await availableName(auth.user.id, body.data.name ?? playlist.title);
    const expiresAt = youtubeMetadataExpiry();
    const collection = await prisma.userMusicCollection.create({
      data: {
        userId: auth.user.id,
        name,
        kind: 'playlist',
        items: {
          create: playlist.videos.map((video) => ({
            source: 'youtube',
            sourceId: video.videoId,
            title: video.title,
            creatorName: video.channelTitle,
            artworkUrl: video.thumbnailUrl,
            sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`,
            artistUrl: null,
            durationSeconds: null,
            expiresAt,
          })),
        },
      },
    });
    return NextResponse.json(
      YouTubePlaylistImportResponseSchema.parse({
        collectionId: collection.id,
        name,
        imported: playlist.videos.length,
        skipped: playlist.skipped,
      }),
      { headers: privateHeaders },
    );
  } catch (error) {
    if (error instanceof YouTubeImportError) {
      const status =
        error.code === 'not_found'
          ? 404
          : error.code === 'invalid_url'
            ? 400
            : error.code === 'api_error'
              ? 502
              : 409;
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status, headers: privateHeaders },
      );
    }
    return NextResponse.json(
      { error: 'import_unavailable', message: 'Importazione non riuscita. Riprova.' },
      { status: 503, headers: privateHeaders },
    );
  }
}
