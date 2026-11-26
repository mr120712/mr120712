// @polsia:user-owned — tiene sveglio il worker yt-dlp (Render/Fly in scale-to-zero). Chiama
// /health del worker da server-side, così `YTDLP_SERVICE_URL` resta un secret Vercel e non deve
// essere duplicato come variabile GitHub Actions. Protetta da CRON_SECRET (Bearer) come gli altri
// cron, programmata in vercel.json. Niente chiave worker: /health è pubblico.
import 'server-only';
import { NextResponse } from 'next/server';
import { ytdlpServiceUrl } from '@/lib/business/bot-video.server';
import { cronAuthorized } from '@/lib/business/cron-auth.server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const noStore = { 'Cache-Control': 'no-store' };

/** Timeout della GET al worker: scalato per includere il cold start di Render free (~25 s). */
const HEALTH_TIMEOUT_MS = 25_000;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  }

  const url = ytdlpServiceUrl();
  if (!url) {
    return NextResponse.json(
      { action: 'skipped', ok: true, reason: 'ytdlp_service_url_not_configured' },
      { headers: noStore },
    );
  }

  const started = Date.now();
  try {
    const res = await fetch(`${url}/health`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const elapsedMs = Date.now() - started;
    if (!res.ok) {
      return NextResponse.json(
        { action: 'pinged', ok: false, status: res.status, elapsedMs },
        { status: 502, headers: noStore },
      );
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; mode?: string } | null;
    return NextResponse.json(
      {
        action: 'pinged',
        ok: true,
        status: res.status,
        elapsedMs,
        mode: body?.mode ?? null,
      },
      { headers: noStore },
    );
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const reason = error instanceof Error ? error.name : 'unknown';
    return NextResponse.json(
      { action: 'pinged', ok: false, reason, elapsedMs },
      { status: 502, headers: noStore },
    );
  }
}
