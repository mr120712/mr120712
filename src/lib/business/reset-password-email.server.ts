// @polsia:user-owned — email di recupero password di Solco, in italiano. Non lancia mai: un invio
// non riuscito viene registrato nei log (better-auth risponde comunque in modo neutro, così non si
// scopre se un indirizzo è iscritto).
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

/** Il saluto non contiene mai il nome: è scelto da chi si registra e finirebbe in un'email Solco. */
export function resetPasswordEmailContent(url: string) {
  const href = escapeHtml(url);
  return {
    subject: 'Reimposta la password di Solco',
    text: `Ciao,\n\nabbiamo ricevuto una richiesta per reimpostare la password del tuo account Solco. Apri questo link entro un'ora per sceglierne una nuova:\n${url}\n\nSe non sei stato tu, ignora questa email: la tua password resta invariata.`,
    html: `<p>Ciao,</p><p>abbiamo ricevuto una richiesta per reimpostare la password del tuo account Solco. Il link vale un'ora:</p><p><a href="${href}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Scegli una nuova password</a></p><p style="color:#666;font-size:13px">Se non sei stato tu, ignora questa email: la tua password resta invariata.</p>`,
  };
}

/** Limiti condivisi tra le istanze: per destinatario, poi per l'intera app. */
async function resetEmailAllowed(email: string) {
  const recipient = await consumeRateLimit(
    'auth.reset_email',
    `email:${email.trim().toLowerCase()}`,
  );
  if (!recipient.allowed) return false;
  const appWide = await consumeRateLimit('auth.reset_email.global', 'global');
  return appWide.allowed;
}

/** better-auth emailAndPassword.sendResetPassword. */
export async function sendResetPasswordEmail(input: { user: { email: string }; url: string }) {
  try {
    // Account creati col telefono: l'email è provvisoria e non consegnabile. Non si invia nulla.
    if (isPhoneAccountEmail(input.user.email)) return;
    if (!(await resetEmailAllowed(input.user.email))) {
      console.warn('[solco] reset password email skipped: rate limit reached or unavailable');
      return;
    }
    const content = resetPasswordEmailContent(input.url);
    if (process.env.RESEND_API_KEY?.trim()) {
      const result = await sendWithResend({ to: input.user.email, ...content });
      if (!result.ok) console.error('[solco] reset password email not sent:', result.error);
      return;
    }
    await sendEmail({ to: input.user.email, ...content });
  } catch (error) {
    console.error(
      '[solco] reset password email not sent:',
      error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    );
  }
}
