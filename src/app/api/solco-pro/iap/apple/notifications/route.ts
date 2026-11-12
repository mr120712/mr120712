// @polsia:user-owned — webhook delle App Store Server Notifications V2 (Apple → server).
//
// Apple invia un JWS firmato a ogni evento (rinnovo, mancato rinnovo, rimborso, revoca…). La
// notifica è solo un INNESCO: verifichiamo la firma, prendiamo l'originalTransactionId e RILEGGIAMO
// lo stato autorevole dallo store. Non concede nulla di per sé.
import 'server-only';
import { NextResponse } from 'next/server';
import { verifyAppleSignedPayload } from '@/lib/business/iap/apple-jws.server';
import { appleIapConfig } from '@/lib/business/iap/config.server';
import { resyncIapSubscription } from '@/lib/business/iap/entitlement.server';
import { readJsonLimited } from '@/lib/business/request-body.server';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request) {
  const config = appleIapConfig();
  if (!config) {
    // Non configurato: niente da fare (evita retry infiniti con un 200).
    return NextResponse.json({ ok: false, reason: 'not_configured' }, { status: 200 });
  }

  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok || typeof body.value !== 'object' || body.value === null) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const signedPayload = (body.value as Record<string, unknown>).signedPayload;
  if (typeof signedPayload !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = verifyAppleSignedPayload(signedPayload, config.rootCas);
  } catch {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  const data = payload.data;
  if (typeof data !== 'object' || data === null) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }
  const dataObj = data as Record<string, unknown>;

  // Il bundleId della notifica deve essere il nostro.
  if (typeof dataObj.bundleId === 'string' && dataObj.bundleId !== config.bundleId) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const signedTransactionInfo = dataObj.signedTransactionInfo;
  if (typeof signedTransactionInfo === 'string') {
    try {
      const txn = verifyAppleSignedPayload(signedTransactionInfo, config.rootCas);
      if (typeof txn.originalTransactionId === 'string') {
        await resyncIapSubscription('apple', txn.originalTransactionId);
      }
    } catch {
      // Transazione non verificabile: ignora, lo stato si riallinea al prossimo accesso.
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
