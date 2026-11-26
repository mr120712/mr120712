import { env } from '@/lib/env';

/**
 * Thin client over Solco's POLSIA_EMAIL_PROXY_URL — the same relay Solco uses for
 * transactional email. Shape expected by the proxy: POST JSON `{ from, to, subject, html, text }`.
 *
 * The gateway's only email is the magic-link, so this is deliberately tiny.
 */
export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendMail(input: SendMailInput): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.POLSIA_EMAIL_API_KEY) {
    headers.authorization = `Bearer ${env.POLSIA_EMAIL_API_KEY}`;
  }

  const body = {
    from: { email: env.GATEWAY_EMAIL_FROM, name: env.GATEWAY_EMAIL_FROM_NAME },
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  };

  const resp = await fetch(env.POLSIA_EMAIL_PROXY_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(
      `email proxy rejected magic link: ${resp.status} ${resp.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
    );
  }
}

/**
 * Render the magic-link email. Plain + HTML, minimal. The URL is already
 * one-shot and expires inside Better Auth; we only have to deliver it.
 */
export function renderMagicLinkEmail(url: string): { subject: string; html: string; text: string } {
  const subject = 'Your ARTEX sign-in link';
  const text = [
    'Click the link below to sign in to the ARTEX console.',
    '',
    url,
    '',
    'If you did not request this, ignore this email. The link expires in 10 minutes and can only be used once.',
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#111">
<h2 style="margin:0 0 16px;font-size:18px">ARTEX sign-in</h2>
<p>Click the button to sign in:</p>
<p><a href="${url}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Open the ARTEX console</a></p>
<p style="color:#666;font-size:13px">Or copy this link into your browser:<br><code style="word-break:break-all">${url}</code></p>
<p style="color:#999;font-size:12px;margin-top:32px">If you did not request this, ignore this email. The link expires in 10 minutes and can be used only once.</p>
</body></html>`;
  return { subject, html, text };
}
