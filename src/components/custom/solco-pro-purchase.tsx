// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import {
  describeSolcoProBusinessAccountStatus,
  describeSolcoProMissingRequirement,
  SOLCO_PRO_BUSINESS_ACCOUNT_STATUS_MESSAGE,
  SOLCO_PRO_CHECKOUT_MISSING_DETAILS,
  SOLCO_PRO_OFFER_SUMMARY,
  SOLCO_PRO_PAYMENT_METHOD,
  SOLCO_PRO_PRICE,
} from '@/lib/business/solco-pro-billing';
import {
  type SolcoProPurchaseReadiness,
  solcoProCheckoutResponseSchema,
  solcoProPurchaseReadinessSchema,
} from '@/lib/contracts/solco-pro';
import styles from './solco-pro-purchase.module.css';

export function SolcoProPurchase() {
  const [readiness, setReadiness] = useState<SolcoProPurchaseReadiness | null>(null);
  const [readinessError, setReadinessError] = useState(false);
  const [checkoutError, setCheckoutError] = useState(false);
  const [startingCheckout, setStartingCheckout] = useState(false);
  const { data: session, isPending: sessionPending } = useSession();

  useEffect(() => {
    let mounted = true;
    void apiFetch('/api/solco-pro/purchase/readiness', { schema: solcoProPurchaseReadinessSchema })
      .then((result) => {
        if (mounted) setReadiness(result);
      })
      .catch(() => {
        if (mounted) setReadinessError(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function beginCheckout() {
    setStartingCheckout(true);
    setCheckoutError(false);
    try {
      const result = await apiFetch('/api/stripe-billing/checkout', {
        method: 'POST',
        schema: solcoProCheckoutResponseSchema,
      });
      window.location.assign(result.url);
    } catch {
      setCheckoutError(true);
    } finally {
      setStartingCheckout(false);
    }
  }

  const missing =
    readiness?.state === 'unavailable'
      ? readiness.missing.map(describeSolcoProMissingRequirement)
      : SOLCO_PRO_CHECKOUT_MISSING_DETAILS;

  return (
    <section className={styles.purchase} aria-labelledby="solco-pro-purchase-title">
      <p className={styles.notice}>
        {readiness
          ? describeSolcoProBusinessAccountStatus(readiness.businessAccount)
          : SOLCO_PRO_BUSINESS_ACCOUNT_STATUS_MESSAGE}
      </p>
      <div className={styles.offer}>
        <h4 id="solco-pro-purchase-title">Un solo prezzo</h4>
        <p className={styles.price}>
          <strong>{SOLCO_PRO_PRICE}</strong>
          <span>un pagamento · un mese</span>
        </p>
      </div>
      <p className={styles.method}>
        Metodo previsto: <strong>{SOLCO_PRO_PAYMENT_METHOD}</strong>
      </p>
      <p>{SOLCO_PRO_OFFER_SUMMARY}. Nessun rinnovo automatico.</p>
      {readiness?.state === 'ready' ? (
        <div className={styles.requirementBlock}>
          {sessionPending ? (
            <output className={styles.state}>Verifica dell’account…</output>
          ) : session?.user ? (
            <>
              <Button
                className={styles.action}
                disabled={startingCheckout}
                onClick={() => void beginCheckout()}
                size="lg"
                type="button"
              >
                {startingCheckout ? 'Apertura di Stripe…' : 'Acquista Solco Pro · 24,00 EUR'}
              </Button>
              {checkoutError ? (
                <p className={styles.notice} role="alert">
                  Polsia non ha avviato il checkout. Pro resta bloccato; nessun ritorno dal browser
                  può confermare il pagamento.
                </p>
              ) : null}
            </>
          ) : (
            <Button asChild className={styles.action} size="lg">
              <Link href="/login">Accedi per acquistare</Link>
            </Button>
          )}
        </div>
      ) : (
        <div className={styles.requirementBlock}>
          <p className={styles.notice}>
            {readinessError
              ? 'La disponibilità non è verificabile adesso. L’acquisto resta disattivato.'
              : 'Acquisto Stripe non disponibile. Capacità non verificate:'}
          </p>
          {!readinessError ? (
            <ul className={styles.requirements}>
              {missing.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
          <output className={styles.state}>Checkout non disponibile</output>
        </div>
      )}
      <p className={styles.notice}>
        Solco Pro si attiva solo dopo la conferma server-side di Stripe. Il ritorno dal checkout non
        sblocca l’accesso. L’accredito sul conto bancario configurato, invece che sul saldo Polsia,
        non è ancora verificato.
      </p>
    </section>
  );
}
