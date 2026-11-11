// @polsia:user-owned — developer token MusicKit per il player Apple Music di Solco.
import 'server-only';
import { NextResponse } from 'next/server';
import { currentAppleMusicToken } from '@/lib/business/apple-music-token.server';
import { siteUrl } from '@/lib/site';

export const dynamic = 'force-dynamic';

export function GET() {
  // Bound to Solco's own origins: the token is useless on any other site.
  const origins = [
    ...new Set([siteUrl, ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '').split(',')]),
  ]
    .map((origin) => origin.trim())
    .filter((origin) => /^https:\/\/[a-z0-9.-]+$/i.test(origin) && !origin.includes('apple.com'));
  const token = currentAppleMusicToken(origins);
  if (!token) {
    return NextResponse.json(
      { error: 'not_configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json({ token }, { headers: { 'Cache-Control': 'private, max-age=3600' } });
}
