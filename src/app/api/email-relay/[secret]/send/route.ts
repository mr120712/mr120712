// @polsia:user-owned — riceve le richieste del modulo email (formato "proxy Polsia") e le invia con Resend.
// Protetto da un segreto nell'indirizzo, noto solo al server (variabile POLSIA_EMAIL_PROXY_URL).
import 'server-only';
import { NextResponse } from 'next/server';
import {
  parseRelayPayload,
  relaySecretMatches,
  sendWithResend,
} from '@/lib/email/resend-relay.server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  if (!relaySecretMatches(secret)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const payload = parseRelayPayload(await request.json().catch(() => null));
  if (!payload) return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  const result = await sendWithResend(payload);
  if (!result.ok) {
    // biome-ignore lint/suspicious/noConsole: server log of the provider error (no secrets).
    console.error('[email-relay] send failed', {
      error: result.error,
      detail: 'detail' in result ? result.detail : null,
    });
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  // Same shape as the Polsia proxy; email_id is numeric there, so it is omitted here.
  return NextResponse.json({ success: true, message_id: result.id });
}
