// @polsia:user-owned — stato del collegamento ad audio.com (GET) e «Scollega» (DELETE, stessa
// origine). Solo amministratori con email verificata. Non espone mai i token: solo se è collegato,
// il nome dell'account (se audio.com lo fornisce), la data, l'ultimo problema come codice fisso e
// l'indirizzo di ritorno registrato. «Scollega» cancella i token e svuota la cache delle ricerche.
import 'server-only';
import { NextResponse } from 'next/server';
import { AudioComConnectionStatusSchema } from '@/lib/contracts/audiocom';
import { clearAudioComSearchCache } from '@/lib/music/audiocom.server';
import { audioComPrivateHeaders, requireAudioComAdmin } from '@/lib/music/audiocom-admin.server';
import { clearAudioComSectionsCache } from '@/lib/music/audiocom-collections.server';
import {
  audioComConnectionStatus,
  disconnectAudioCom,
} from '@/lib/music/audiocom-connection.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

function logFailure(what: string, error: unknown) {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (mai token).
  console.error(`[admin/audiocom] ${what}:`, error instanceof Error ? error.name : typeof error);
}

export async function GET(request: Request) {
  const access = await requireAudioComAdmin(request);
  if (!access.allowed) return access.response;
  try {
    const body = AudioComConnectionStatusSchema.parse(await audioComConnectionStatus());
    return NextResponse.json(body, { headers: audioComPrivateHeaders });
  } catch (error) {
    logFailure('stato non disponibile', error);
    return NextResponse.json(
      {
        error: 'audiocom_status_unavailable',
        message: 'Lo stato del collegamento ad audio.com non è disponibile. Riprova tra poco.',
      },
      { status: 500, headers: audioComPrivateHeaders },
    );
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: audioComPrivateHeaders },
    );
  }
  const access = await requireAudioComAdmin(request);
  if (!access.allowed) return access.response;
  try {
    await disconnectAudioCom();
    clearAudioComSearchCache();
    // Anche le sezioni «In evidenza da audio.com» della Home seguono il nuovo collegamento.
    clearAudioComSectionsCache();
    return NextResponse.json({ disconnected: true }, { headers: audioComPrivateHeaders });
  } catch (error) {
    logFailure('scollegamento non riuscito', error);
    return NextResponse.json(
      {
        error: 'audiocom_disconnect_failed',
        message: 'Non è stato possibile scollegare audio.com. Riprova tra poco.',
      },
      { status: 500, headers: audioComPrivateHeaders },
    );
  }
}
