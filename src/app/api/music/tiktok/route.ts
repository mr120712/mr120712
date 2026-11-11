// @polsia:user-owned — video TikTok scelti dall'amministratore per un genere (o per la Home).
import 'server-only';
import { NextResponse } from 'next/server';
import { TikTokClipListSchema } from '@/lib/contracts/library';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const genre = new URL(request.url).searchParams.get('genre');
  if (genre !== null && !/^[a-z0-9-]{1,80}$/.test(genre)) {
    return NextResponse.json({ error: 'invalid_genre' }, { status: 400 });
  }
  const clips = await prisma.tikTokClip
    .findMany({
      where: { genreSlug: genre ?? null },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: {
        id: true,
        videoId: true,
        handle: true,
        canonicalUrl: true,
        soundUrl: true,
        caption: true,
        genreSlug: true,
      },
    })
    .catch(() => []);
  return NextResponse.json(TikTokClipListSchema.parse({ clips }), {
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' },
  });
}
