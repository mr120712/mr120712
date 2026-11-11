// @polsia:user-owned — gestione dei video TikTok scelti dall'amministratore (aggiungi, elenca,
// rimuovi). Solo amministratori con email verificata; nessuna chiamata a TikTok dal server.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { TikTokClipCreateSchema, TikTokClipListSchema } from '@/lib/contracts/library';
import { prisma } from '@/lib/db';
import { findGenre } from '@/lib/music/genre-catalog';
import {
  musicRightsPrivateHeaders as privateHeaders,
  requireVerifiedMusicRightsAdmin,
} from '@/lib/music/rights-admin.server';
import { isTikTokShortLink, parseTikTokSoundUrl, parseTikTokVideoUrl } from '@/lib/music/tiktok';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const select = {
  id: true,
  videoId: true,
  handle: true,
  canonicalUrl: true,
  soundUrl: true,
  caption: true,
  genreSlug: true,
} as const;

export async function GET(request: Request) {
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;
  const clips = await prisma.tikTokClip.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
    select,
  });
  return NextResponse.json(TikTokClipListSchema.parse({ clips }), { headers: privateHeaders });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;
  const limited = await enforceRateLimit('library.write', `user:${access.user.id}`);
  if (limited) return limited;
  const payload = await readJsonLimited(request, 4 * 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = TikTokClipCreateSchema.safeParse(payload.value);
  if (!body.success) {
    return NextResponse.json(
      { errors: { url: 'Incolla il link completo di un video TikTok.' } },
      { status: 400, headers: privateHeaders },
    );
  }
  const video = parseTikTokVideoUrl(body.data.url);
  if (!video) {
    return NextResponse.json(
      {
        errors: {
          url: isTikTokShortLink(body.data.url)
            ? 'È un link breve: aprilo nel browser e copia il link completo (…tiktok.com/@autore/video/…).'
            : 'Link non valido: serve il link completo di un video TikTok (…tiktok.com/@autore/video/…).',
        },
      },
      { status: 400, headers: privateHeaders },
    );
  }
  const soundUrl = body.data.soundUrl ? parseTikTokSoundUrl(body.data.soundUrl) : null;
  if (body.data.soundUrl && !soundUrl) {
    return NextResponse.json(
      { errors: { soundUrl: 'Link del suono non valido (…tiktok.com/music/…).' } },
      { status: 400, headers: privateHeaders },
    );
  }
  const genreSlug = body.data.genreSlug || null;
  if (genreSlug && !findGenre(genreSlug)) {
    return NextResponse.json(
      { errors: { genreSlug: 'Genere sconosciuto.' } },
      { status: 400, headers: privateHeaders },
    );
  }
  const existing = await prisma.tikTokClip.findUnique({ where: { videoId: video.videoId } });
  if (existing) {
    return NextResponse.json(
      { errors: { url: 'Questo video è già stato aggiunto.' } },
      { status: 409, headers: privateHeaders },
    );
  }
  const clip = await prisma.tikTokClip.create({
    data: {
      ...video,
      soundUrl,
      caption: body.data.caption || null,
      genreSlug,
      createdById: access.user.id,
    },
    select,
  });
  return NextResponse.json({ clip }, { status: 201, headers: privateHeaders });
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[a-z0-9]{10,40}$/.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400, headers: privateHeaders });
  }
  await prisma.tikTokClip.deleteMany({ where: { id } });
  return NextResponse.json({ deleted: true }, { headers: privateHeaders });
}
