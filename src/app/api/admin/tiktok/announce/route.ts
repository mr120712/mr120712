// @polsia:user-owned — genera un annuncio TikTok per Solco con Claude 5.5. Stato (GET) e
// generazione (POST, stessa origine). Solo amministratori verificati; ogni call è una richiesta a
// pagamento, quindi è limitata per frequenza. Non pubblica nulla su TikTok.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  generateTikTokAnnouncement,
  tiktokAnnounceConfigured,
} from '@/lib/business/tiktok-announce.server';
import { TikTokAnnounceRequestSchema } from '@/lib/contracts/tiktok-announce';
import { findGenre } from '@/lib/music/genre-catalog';
import {
  musicRightsPrivateHeaders as privateHeaders,
  requireVerifiedMusicRightsAdmin,
} from '@/lib/music/rights-admin.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// La chiamata ad Anthropic ha una scadenza di 100 s sotto questo limite di 120 s.
export const maxDuration = 120;

const errorStatus = { not_configured: 503, refused: 422, busy: 503, failed: 502 } as const;
const errorMessage = {
  not_configured: 'La generazione con l’AI non è ancora attiva (manca ANTHROPIC_API_KEY).',
  refused: 'Non posso scrivere questo annuncio. Prova a cambiare l’argomento o il taglio.',
  busy: 'L’AI è molto richiesta in questo momento. Riprova tra poco.',
  failed: 'La generazione non è riuscita. Riprova.',
} as const;

export async function GET(request: Request) {
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;
  return NextResponse.json(
    { aiConfigured: tiktokAnnounceConfigured() },
    { headers: privateHeaders },
  );
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

  const limited = await enforceRateLimit(
    'tiktok.announce.admin',
    getRateLimitIdentity(access.user.id, request.headers),
  );
  if (limited) return limited;
  const globallyLimited = await enforceRateLimit('tiktok.announce.global', 'global');
  if (globallyLimited) return globallyLimited;

  const payload = await readJsonLimited(request, 4 * 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = TikTokAnnounceRequestSchema.safeParse(payload.value);
  if (!parsed.success) {
    return NextResponse.json(
      { errors: { topic: parsed.error.issues[0]?.message ?? 'Richiesta non valida.' } },
      { status: 400, headers: privateHeaders },
    );
  }
  if (parsed.data.genreSlug && !findGenre(parsed.data.genreSlug)) {
    return NextResponse.json(
      { errors: { genreSlug: 'Genere sconosciuto.' } },
      { status: 400, headers: privateHeaders },
    );
  }

  const result = await generateTikTokAnnouncement(parsed.data);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: errorMessage[result.error] },
      { status: errorStatus[result.error], headers: privateHeaders },
    );
  }
  return NextResponse.json(
    { announcement: result.announcement, model: result.model },
    { headers: privateHeaders },
  );
}
