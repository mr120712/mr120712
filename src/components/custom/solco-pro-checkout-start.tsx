// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import styles from '@/app/(setup)/checkout/checkout.module.css';
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

export function SolcoProCheckoutStart() {
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
  const ready = readiness?.state === 'ready';

  return (
    <section className={styles.card} aria-labelledby="checkout-title">
      <p className={styles.eyebrow}>SOLCO PRO · PAGAMENTO UNA TANTUM</p>
      <h1 id="checkout-title">{SOLCO_PRO_PRICE}</h1>
      <p>
        {SOLCO_PRO_OFFER_SUMMARY}. Metodo previsto: {SOLCO_PRO_PAYMENT_METHOD}. Nessun rinnovo.
      </p>
      <p className={styles.notice}>
        {readiness
          ? describeSolcoProBusinessAccountStatus(readiness.businessAccount)
          : SOLCO_PRO_BUSINESS_ACCOUNT_STATUS_MESSAGE}
      </p>
      <section className={styles.paymentNotice} aria-labelledby="payment-availability-title">
        <div className={styles.paymentHeading}>
          <h2 id="payment-availability-title">Stripe</h2>
          <span>{ready ? 'Pronto' : 'Non disponibile'}</span>
        </div>
        {ready ? (
          sessionPending ? (
            <output className={styles.pending}>Verifica dell’account…</output>
          ) : session?.user ? (
            <>
              <Button
                className={styles.action}
                disabled={startingCheckout}
                onClick={() => void beginCheckout()}
                size="lg"
                type="button"
              >
                {startingCheckout ? 'Apertura di Stripe…' : 'Vai al checkout Stripe'}
              </Button>
              {checkoutError ? (
                <p className={styles.alert} role="alert">
                  Stripe non ha creato il checkout. Nessun accesso Pro è stato attivato.
                </p>
              ) : null}
            </>
          ) : (
            <p>
              <Link className={styles.returnLink} href="/login">
                Accedi a Solco per associare il pagamento al tuo account.
              </Link>
            </p>
          )
        ) : (
          <>
            <p>
              {readinessError
                ? 'La disponibilità Stripe non è verificabile ora. Nessun checkout viene creato.'
                : 'Il checkout EUR non è ancora disponibile. L’account Business risulta configurato e l’onboarding completo; Polsia non prova ancora tutte le capacità richieste.'}
            </p>
            {!readinessError ? (
              <ul className={styles.requirements}>
                {missing.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>
      <p className={styles.notice}>
        Solo una conferma server-side verificata del pagamento può attivare Pro. Il ritorno dal
        checkout non prova il pagamento. L’accredito sul conto bancario configurato, invece che sul
        saldo Polsia, non è ancora verificato.
      </p>
      <Link className={styles.returnLink} href="/#piani">
        Torna ai prezzi
      </Link>
    </section>
  );
}
