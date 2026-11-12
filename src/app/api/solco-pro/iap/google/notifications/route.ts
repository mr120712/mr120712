// @polsia:user-owned — webhook delle Real-time Developer Notifications di Google (Pub/Sub push).
//
// Google invia, via Pub/Sub, una notifica a ogni evento dell'abbonamento. Come per Apple è solo un
// INNESCO: estraiamo il purchaseToken e RILEGGIAMO lo stato autorevole dallo store. Un segreto
// condiviso nella URL di push (confrontato a tempo costante) tiene fuori le richieste casuali, ma
// la sicurezza vera è che la notifica non concede nulla: si rilegge sempre da Google.
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { googlePlayConfig, googleRtdnSecret } from '@/lib/business/iap/config.server';
import { resyncIapSubscription } from '@/lib/business/iap/entitlement.server';
import { readJsonLimited } from '@/lib/business/request-body.server';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

function secretMatches(request: Request): boolean {
  const expected = googleRtdnSecret();
  if (!expected) return true; // Nessun segreto configurato: accetta (la rilettura resta autorevole).
  const given = new URL(request.url).searchParams.get('secret') ?? '';
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export async function POST(request: Request) {
  const config = googlePlayConfig();
  if (!config) {
    return NextResponse.json({ ok: false, reason: 'not_configured' }, { status: 200 });
  }
  if (!secretMatches(request)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok || typeof body.value !== 'object' || body.value === null) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const message = (body.value as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }
  const dataB64 = (message as Record<string, unknown>).data;
  if (typeof dataB64 !== 'string') {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  let notification: Record<string, unknown>;
  try {
    notification = JSON.parse(Buffer.from(dataB64, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  // Il packageName deve essere il nostro.
  if (
    typeof notification.packageName === 'string' &&
    notification.packageName !== config.packageName
  ) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const subscriptionNotification = notification.subscriptionNotification;
  if (typeof subscriptionNotification === 'object' && subscriptionNotification !== null) {
    const purchaseToken = (subscriptionNotification as Record<string, unknown>).purchaseToken;
    if (typeof purchaseToken === 'string' && purchaseToken) {
      await resyncIapSubscription('google', purchaseToken);
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
