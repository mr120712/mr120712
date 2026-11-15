// @polsia:user-owned — chi ha diritto all'ascolto completo e in background (Premium/Pro).
import 'server-only';
import { hasActiveIapSubscription } from '@/lib/business/iap/entitlement.server';
import { hasEmailPremiumGrant } from '@/lib/business/premium-grants.server';
import { getActiveGrant } from '@/lib/business/rewards.server';
import { findActiveSolcoProEntitlement } from '@/lib/business/solco-pro-entitlement';
import { hasActiveSubscription } from '@/lib/business/stripe-subscriptions.server';
import type { AccountPremiumSource } from '@/lib/contracts/account-premium';
import { getSessionUser } from '@/lib/require-auth';

/**
 * Da dove viene il Premium dell'utente: la prima fonte attiva, nell'ordine dei controlli (dal più
 * economico; il Premium illimitato per ultimo), oppure null per un account Free. Fail closed: se un
 * controllo non risponde, null (meglio l'anteprima che un Premium non dovuto).
 */
export async function premiumAccessSource(userId: string): Promise<AccountPremiumSource | null> {
  try {
    if (await findActiveSolcoProEntitlement(userId)) return 'solcoPro';
    // Free Premium earned through rewards (invites, founders, listening, loyalty, birthday).
    if (await getActiveGrant(userId)) return 'rewards';
    // Abbonamento con Stripe o PayPal.
    if (await hasActiveSubscription(userId)) return 'subscription';
    // Abbonamento comprato con un acquisto in-app (Apple App Store / Google Play).
    if (await hasActiveIapSubscription(userId)) return 'inApp';
    // Premium illimitato concesso dall'amministratore all'email VERIFICATA dell'account. Per
    // ultima e da sola: se non si può leggere, le altre fonti hanno già deciso.
    return (await hasEmailPremiumGrant(userId).catch(() => false)) ? 'unlimited' : null;
  } catch {
    // Fail closed: when the check is unavailable, serve the preview.
    return null;
  }
}

/**
 * true se l'utente ha un abbonamento attivo (Stripe/PayPal/in-app), un accesso Solco Pro valido, un
 * premio in corso o il Premium illimitato concesso dall'admin alla sua email verificata.
 */
export async function hasPremiumAccess(userId: string) {
  return (await premiumAccessSource(userId)) !== null;
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
