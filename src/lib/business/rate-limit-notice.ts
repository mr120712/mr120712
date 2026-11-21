// @polsia:user-owned
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
export const RATE_LIMIT_PROTECTION_NOTICE =
  'Il rate limiting di Solco agisce solo quando una richiesta raggiunge l’applicazione. Non assorbe la saturazione della banda o delle connessioni e non protegge da un DDoS di rete. IP condivisi possono far ricadere più persone sullo stesso limite; IP ruotati rendono meno affidabile l’identificazione. Per questi rischi serve una protezione del provider, CDN o WAF a livello di rete.';

export function canViewRateLimitNotice(
  user:
    | { role?: string | null; email?: string | null; emailVerified?: boolean | null }
    | null
    | undefined,
): boolean {
  return isAuthorizedAdmin(user);
}
