// @polsia:user-owned — chi ha diritto all'ascolto completo e in background (Premium/Pro).
import 'server-only';
import { findActiveSolcoProEntitlement } from '@/lib/business/solco-pro-entitlement';
import { hasActiveSubscription } from '@/lib/business/stripe-subscriptions.server';
import { getSessionUser } from '@/lib/require-auth';

/** true se l'utente ha un abbonamento attivo (Stripe/PayPal) o un accesso Solco Pro valido. */
export async function hasPremiumAccess(userId: string) {
  try {
    if (await findActiveSolcoProEntitlement(userId)) return true;
    return await hasActiveSubscription(userId);
  } catch {
    // Fail closed: when the check is unavailable, serve the preview.
    return false;
  }
}

/** Accesso Premium per la richiesta corrente (cookie di sessione); false per gli ospiti. */
export async function currentUserHasPremium() {
  const user = await getSessionUser().catch(() => null);
  return user ? hasPremiumAccess(user.id) : false;
}
