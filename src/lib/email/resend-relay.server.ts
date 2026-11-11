// @polsia:user-owned — invio email tramite Resend (https://resend.com) quando il sito non gira su
// Polsia. Il modulo email di Polsia (framework) continua a chiamare il suo "proxy": su Vercel
// POLSIA_EMAIL_PROXY_URL punta a /api/email-relay/<segreto>, che inoltra qui a Resend.
import 'server-only';
import { timingSafeEqual } from 'node:crypto';

export type RelayPayload = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  body?: string;
};

export function relaySecretMatches(provided: string) {
  const expected = process.env.EMAIL_RELAY_SECRET?.trim() ?? '';
  if (expected.length < 24) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseRelayPayload(value: unknown): RelayPayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const to = typeof v.to === 'string' ? v.to.trim() : '';
  const subject = typeof v.subject === 'string' ? v.subject.trim() : '';
  const html = typeof v.html === 'string' ? v.html : '';
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to) || to.length > 254) return null;
  if (!subject || subject.length > 300 || !html || html.length > 200_000) return null;
  const text =
    typeof v.text === 'string' ? v.text : typeof v.body === 'string' ? v.body : undefined;
  return { to, subject, html, ...(text ? { text: text.slice(0, 100_000) } : {}) };
}

export async function sendWithResend(payload: RelayPayload, fetcher: typeof fetch = fetch) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || 'Solco <onboarding@resend.dev>';
  if (!apiKey) return { ok: false as const, status: 503, error: 'email_not_configured' };
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
      ...(payload.text ? { text: payload.text } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return {
      ok: false as const,
      status: 502,
      error: `resend_${response.status}`,
      detail: detail.slice(0, 300),
    };
  }
  const body = (await response.json().catch(() => ({}))) as { id?: unknown };
  return { ok: true as const, id: typeof body.id === 'string' ? body.id : '' };
}
