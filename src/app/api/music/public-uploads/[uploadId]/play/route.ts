// @polsia:user-owned — registra un ascolto di un brano pubblico (playCount della classifica
// «Brani più ascoltati dalla community»). Same-origin contro i gonfiaggi da terze parti e limite
// per rete (IPv6: per /64). Conta SOLO chi può davvero ascoltare il brano: un account Premium che
// non ne è l'autore. Agli altri la classifica non invia lo streamUrl, quindi una loro richiesta qui
// non è un ascolto. Al massimo UN ascolto per account, per brano, per giorno; la risposta è sempre
// la stessa, contato o no.
import 'server-only';
import { NextResponse } from 'next/server';
import { networkIdentity } from '@/lib/business/auth-guards.server';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { recordPublicUploadPlay } from '@/lib/music/public-uploads.server';
import { getSessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const idPattern = /^[a-z0-9]{20,40}$/;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  const { uploadId } = await params;
  if (!idPattern.test(uploadId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Identità di rete dalla stessa fonte dei limiti (x-real-ip dell'ingress): "ip:<IPv4>" o
  // "ip6:<prefisso>::/64", così cambiare indirizzo dentro lo stesso /64 non dà un limite nuovo.
  const network = networkIdentity(request.headers);
  const limited = await enforceRateLimit('listening.write', `play:${network ?? 'anon'}`);
  if (limited) return limited;

  const viewer = await getSessionUser();
  // Stessa regola dello streamUrl in listPublicUploads: ascolta chi è Premium (o l'autore, che
  // però non fa punti: lo esclude recordPublicUploadPlay). Ospiti e account gratuiti non contano.
  if (viewer && (await hasPremiumAccess(viewer.id))) {
    await recordPublicUploadPlay(uploadId, { userId: viewer.id, network });
  }
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
