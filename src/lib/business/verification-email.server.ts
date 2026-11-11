// @polsia:user-owned — email di verifica di Solco, in italiano. Non blocca mai la registrazione:
// un invio non riuscito viene registrato nei log e l'utente resta registrato.
import 'server-only';
import { sendWithResend } from '@/lib/email/resend-relay.server';
import { sendEmail } from '@/lib/email/send';

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;');
}

export function verificationEmailContent(name: string | null | undefined, url: string) {
  const greeting = name?.trim() ? `Ciao ${name.trim()},` : 'Ciao,';
  const href = escapeHtml(url);
  return {
    subject: 'Conferma la tua email su Solco',
    text: `${greeting}\n\nbenvenuto in Solco! Conferma il tuo indirizzo email aprendo questo link:\n${url}\n\nSe non hai creato un account Solco, ignora questa email.`,
    html: `<p>${escapeHtml(greeting)}</p><p>benvenuto in Solco! Conferma il tuo indirizzo email:</p><p><a href="${href}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Conferma email</a></p><p style="color:#666;font-size:13px">Se non hai creato un account Solco, ignora questa email.</p>`,
  };
}

/** Sends directly to Resend when configured (no extra hop through the relay), else the platform proxy. */
export async function sendVerificationEmail(input: {
  user: { email: string; name?: string | null };
  url: string;
}) {
  const content = verificationEmailContent(input.user.name, input.url);
  try {
    if (process.env.RESEND_API_KEY?.trim()) {
      const result = await sendWithResend({ to: input.user.email, ...content });
      if (!result.ok) console.error('[solco] verification email not sent:', result.error);
      return;
    }
    await sendEmail({ to: input.user.email, ...content });
  } catch (error) {
    console.error(
      '[solco] verification email not sent:',
      error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    );
  }
}
