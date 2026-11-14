// @polsia:user-owned — email di verifica di Solco, in italiano. Non blocca mai la registrazione:
// un invio non riuscito viene registrato nei log e l'utente resta registrato.
import 'server-only';
import { isPhoneAccountEmail } from '@/lib/business/phone-auth';
import { consumeRateLimit } from '@/lib/business/rate-limit.server';
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

/**
 * Il saluto non contiene mai il nome: è scelto da chi si registra (anche da un estraneo con
 * l'indirizzo di qualcun altro) e finirebbe in un'email firmata Solco.
 */
export function verificationEmailContent(url: string) {
  const greeting = 'Ciao,';
  const href = escapeHtml(url);
  return {
    subject: 'Conferma la tua email su Solco',
    text: `${greeting}\n\nbenvenuto in Solco! Conferma il tuo indirizzo email aprendo questo link:\n${url}\n\nSe non hai creato un account Solco, ignora questa email.`,
    html: `<p>${greeting}</p><p>benvenuto in Solco! Conferma il tuo indirizzo email:</p><p><a href="${href}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Conferma email</a></p><p style="color:#666;font-size:13px">Se non hai creato un account Solco, ignora questa email.</p>`,
  };
}

/**
 * Limiti condivisi tra le istanze (il limiter di better-auth è in memoria): prima per destinatario,
 * poi per l'intera app, così un indirizzo già bloccato non consuma la quota globale.
 */
async function verificationEmailAllowed(email: string) {
  const recipient = await consumeRateLimit(
    'auth.verification_email',
    `email:${email.trim().toLowerCase()}`,
  );
  if (!recipient.allowed) return false;
  const appWide = await consumeRateLimit('auth.verification_email.global', 'global');
  return appWide.allowed;
}

/** Sends directly to Resend when configured (no extra hop through the relay), else the platform proxy. */
export async function sendVerificationEmail(input: {
  user: { email: string; name?: string | null };
  url: string;
}) {
  try {
    // Account creati col telefono: l'email è provvisoria e non consegnabile. Non si invia nulla.
    if (isPhoneAccountEmail(input.user.email)) return;
    if (!(await verificationEmailAllowed(input.user.email))) {
      console.warn('[solco] verification email skipped: rate limit reached or unavailable');
      return;
    }
    const content = verificationEmailContent(input.url);
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
