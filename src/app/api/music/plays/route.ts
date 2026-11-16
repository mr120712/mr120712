// @polsia:user-owned — il player chiede il permesso prima di avviare un brano (limite free).
// Per quasi tutte le fonti è solo una verifica: l'ascolto viene registrato dalle route di stream
// quando l'audio parte davvero, così un brano che fallisce (verifica /playback, licenza, fonte giù)
// non costa nulla.
// Eccezione: le fonti che il browser ascolta direttamente, senza una route di stream di Solco
// (audio.com, `audiocom:<id>`: vedi permitRecordsPlay). Nessuna route vedrà mai quell'audio,
// quindi qui il permesso REGISTRA l'ascolto Free (stessa scrittura delle route di stream, con la
// finestra di 30 minuti per i riascolti) e il player non fa partire l'audio senza questo sì.
// I brani in evidenza della Home (`upload:<pathname>`, conteggio Free a parte di 30 avvii al mese)
// sono solo verificati qui, come Audius: registra la loro route /api/music/home-tracks/stream.
import 'server-only';
import { NextResponse } from 'next/server';
import { isValidPlayId, type PlayDecision, permitRecordsPlay } from '@/lib/business/play-quota';
import { playDeniedResponse } from '@/lib/business/play-quota.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { checkStreamPlay, recordStreamPlay } from '@/lib/music/stream-play.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  // Un id di brano in evidenza porta il pathname del file (fino a 1024 caratteri, in JSON).
  const payload = await readJsonLimited(request, 2048);
  if (!payload.ok) return limitedJsonError(payload);
  const qualifiedId =
    payload.value && typeof payload.value === 'object'
      ? (payload.value as { qualifiedId?: unknown }).qualifiedId
      : null;
  if (typeof qualifiedId !== 'string' || !isValidPlayId(qualifiedId)) {
    return NextResponse.json({ error: 'invalid_track' }, { status: 400 });
  }
  // Same read-only decision as the stream routes (Jamendo switched off included).
  const play = await checkStreamPlay(qualifiedId);
  if (!play.decision.allowed) return playDeniedResponse(play.decision);
  let decision: PlayDecision = play.decision;
  if (permitRecordsPlay(qualifiedId)) {
    // audio.com: l'ascolto si registra qui (nessuna route di stream lo vedrà). `recordStreamPlay`
    // non scrive per Premium né per un riascolto entro 30 minuti, e rifà il controllo nella
    // transazione: se nel frattempo il limite è stato raggiunto, la risposta è il rifiuto (402).
    try {
      decision = await recordStreamPlay(play);
    } catch {
      // Registro degli ascolti non disponibile (conflitti oltre i tentativi, database giù): come
      // le route di stream si fallisce chiusi, e il player non fa partire l'audio.
      return NextResponse.json(
        { error: 'play_unavailable' },
        { status: 503, headers: privateHeaders },
      );
    }
    if (!decision.allowed) return playDeniedResponse(decision);
  }
  return NextResponse.json(
    { allowed: true, used: decision.used, limit: decision.limit },
    { headers: privateHeaders },
  );
}
