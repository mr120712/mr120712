// @polsia:user-owned — chi ha diritto all'ascolto completo e in background (Premium/Pro).
import 'server-only';
import { hasActiveIapSubscription } from '@/lib/business/iap/entitlement.server';
import { hasEmailPremiumGrant } from '@/lib/business/premium-grants.server';
import { getActiveGrant } from '@/lib/business/rewards.server';
import { findActiveSolcoProEntitlement } from '@/lib/business/solco-pro-entitlement';
import { hasActiveSubscription } from '@/lib/business/stripe-subscriptions.server';
import { getSessionUser } from '@/lib/require-auth';

/**
 * true se l'utente ha un abbonamento attivo (Stripe/PayPal/in-app), un accesso Solco Pro valido, un
 * premio in corso o il Premium illimitato concesso dall'admin alla sua email verificata.
 */
export async function hasPremiumAccess(userId: string) {
  try {
    if (await findActiveSolcoProEntitlement(userId)) return true;
    // Free Premium earned through rewards (invites, founders, listening, loyalty, birthday).
    if (await getActiveGrant(userId)) return true;
    if (await hasActiveSubscription(userId)) return true;
    // Abbonamento comprato con un acquisto in-app (Apple App Store / Google Play).
    if (await hasActiveIapSubscription(userId)) return true;
    // Premium illimitato concesso dall'amministratore all'email VERIFICATA dell'account. Per
    // ultima e da sola: se non si può leggere, le altre fonti hanno già deciso.
    return await hasEmailPremiumGrant(userId).catch(() => false);
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

/** Utente corrente e accesso Premium (per il player). */
export async function currentAccess() {
  const user = await getSessionUser().catch(() => null);
  return { signedIn: Boolean(user), premium: user ? await hasPremiumAccess(user.id) : false };
}
