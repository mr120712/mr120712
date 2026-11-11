// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/email@0.5.2. Drift = commit rejected.
// Server-only sendEmail transport — POSTs to the Polsia email proxy. Import it from your app's
// OWN server route handlers (never expose a generic /api/email route). Compose subject/html/text in
// the user-owned @/lib/email/templates, then: sendEmail({ to, ...welcomeEmail({ name }) }).

import 'server-only';
import { env } from '@/lib/env';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // Thread a reply onto a received message (its company_emails id, from the /api/proxy/email/inbox
  // feed). Genuine replies skip the cold-send cap. Omit to start a new thread.
  replyToEmailId?: string;
}

export interface SendEmailResult {
  // company_emails id of the stored outbound message. Empty string when the recipient was
  // suppressed (unsubscribed/bounced) — the proxy accepted the call but sent nothing.
  id: string;
}

/**
 * Base of the Polsia email proxy — the injected URL with any trailing slash and any `/send`
 * suffix stripped, so `${proxyBaseUrl()}/<route>` addresses the whole `/api/proxy/email/*`
 * family. Exported so the sibling framework transport (`./submissions`) derives the SAME base
 * instead of re-deriving it and drifting.
 */
export function proxyBaseUrl(): string {
  return env.POLSIA_EMAIL_PROXY_URL.replace(/\/+$/, '').replace(/\/send$/, '');
}

export async function sendEmail(
  input: SendEmailInput,
  options?: { signal?: AbortSignal },
): Promise<SendEmailResult> {
  const url = `${proxyBaseUrl()}/send`;
  const body =
    input.text ??
    input.html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  // POLSIA_API_KEY via process.env (platform-injected; not in typed env — ai/stripe declare it).
  const res = await fetch(url, {
    method: 'POST',
    // Bound connection and response-body reads; allow a caller's earlier deadline.
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.POLSIA_API_KEY ?? ''}`,
    },
    body: JSON.stringify({
      to: input.to,
      subject: input.subject,
      body,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
      ...(input.replyToEmailId ? { reply_to_email_id: input.replyToEmailId } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`email proxy send failed: ${res.status} ${detail}`.trim());
  }
  // Proxy returns { success, email_id: number, message_id, ... }, email_id absent when suppressed.
  // Stringify it so id matches SendEmailResult at runtime (e.g. 8064 -> "8064").
  const json = (await res.json()) as { email_id?: number };
  return { id: json.email_id == null ? '' : String(json.email_id) };
}
