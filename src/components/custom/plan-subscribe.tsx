// @polsia:user-owned — scelta mensile/annuale e pulsanti di abbonamento (Stripe Checkout).
'use client';

import { Check } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import {
  type BillingPeriod,
  type PaidPlanId,
  SubscriptionCheckoutResponseSchema,
  SubscriptionPortalResponseSchema,
  type SubscriptionState,
  SubscriptionStateSchema,
} from '@/lib/contracts/subscriptions';
import styles from '../../app/(custom)/piani/piani.module.css';

export type PlanCard = {
  id: 'free' | PaidPlanId;
  name: string;
  monthlyEuroCents: number;
  annualEuroCents: number;
  annualSavingsEuroCents: number;
  benefits: string[];
};

/** Link di pagamento PayPal del titolare (pagina di checkout ospitata da PayPal). */
export const PAYPAL_PAYMENT_LINK = 'https://www.paypal.com/ncp/payment/5HF3PEA5GM75U';

const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });

function errorMessage(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown })
      : null;
  return typeof cause?.message === 'string' ? cause.message : 'Pagamento non avviato. Riprova.';
}

export function PlanSubscribe({ plans }: { plans: PlanCard[] }) {
  const { data: session } = useSession();
  const [period, setPeriod] = useState<BillingPeriod>('month');
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/subscriptions', { schema: SubscriptionStateSchema })
      .then(setState)
      .catch(() => setState({ enabled: false, paypalEnabled: false, subscription: null }));
  }, []);

  const current = state?.subscription?.active ? state.subscription : null;

  const subscribe = async (planId: PaidPlanId, provider: 'stripe' | 'paypal' = 'stripe') => {
    setPending(`${provider}:${planId}`);
    try {
      const endpoint =
        provider === 'paypal'
          ? '/api/subscriptions/paypal/checkout'
          : '/api/subscriptions/checkout';
      const { url } = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ planId, period }),
        schema: SubscriptionCheckoutResponseSchema,
      });
      window.location.assign(url);
    } catch (error) {
      toast.error(errorMessage(error));
      setPending(null);
    }
  };

  const manage = async () => {
    if (current?.provider === 'paypal') {
      window.open('https://www.paypal.com/myaccount/autopay/', '_blank', 'noopener');
      return;
    }
    setPending('portal');
    try {
      const { url } = await apiFetch('/api/subscriptions/portal', {
        method: 'POST',
        schema: SubscriptionPortalResponseSchema,
      });
      window.location.assign(url);
    } catch (error) {
      toast.error(errorMessage(error));
      setPending(null);
    }
  };

  return (
    <>
      <fieldset className={styles.periods}>
        <legend className="sr-only">Periodo di fatturazione</legend>
        <button type="button" aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>
          Mensile
        </button>
        <button type="button" aria-pressed={period === 'year'} onClick={() => setPeriod('year')}>
          Annuale · risparmia
        </button>
      </fieldset>

      {current ? (
        <div className={styles.currentPlan}>
          <p>
            Il tuo piano: <strong>{plans.find((p) => p.id === current.planId)?.name}</strong> (
            {current.period === 'month' ? 'mensile' : 'annuale'})
            {current.currentPeriodEnd
              ? ` · ${current.cancelAtPeriodEnd ? 'termina' : 'si rinnova'} il ${new Date(
                  current.currentPeriodEnd,
                ).toLocaleDateString('it-IT')}`
              : ''}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void manage()}
            disabled={pending !== null}
          >
            Gestisci abbonamento
          </Button>
        </div>
      ) : null}

      <ul className={styles.grid}>
        {plans.map((plan) => {
          const free = plan.id === 'free';
          const amount = period === 'month' ? plan.monthlyEuroCents : plan.annualEuroCents;
          const isCurrent = current?.planId === plan.id;
          return (
            <li key={plan.id} className={styles.card} data-plan={plan.id}>
              <h2>{plan.name}</h2>
              <p className={styles.price}>
                <strong>{free ? 'Gratis' : euro.format(amount / 100)}</strong>
                {free ? null : <span>/{period === 'month' ? 'mese' : 'anno'}</span>}
              </p>
              {!free && period === 'year' ? (
                <p className={styles.annual}>
                  Risparmi {euro.format(plan.annualSavingsEuroCents / 100)} rispetto al mensile
                </p>
              ) : null}
              <ul className={styles.benefits}>
                {plan.benefits.map((benefit) => (
                  <li key={benefit}>
                    <Check aria-hidden="true" />
                    {benefit}
                  </li>
                ))}
              </ul>
              {free ? null : isCurrent ? (
                <p className={styles.soon}>Piano attuale</p>
              ) : !state ? (
                <p className={styles.soon}>Verifica disponibilità…</p>
              ) : !state.enabled && !state.paypalEnabled ? (
                <p className={styles.soon}>Abbonamento in arrivo</p>
              ) : !session?.user ? (
                <Button asChild className={styles.cta}>
                  <Link href="/login?callbackURL=%2Fpiani">Accedi per abbonarti</Link>
                </Button>
              ) : current ? (
                <Button
                  type="button"
                  variant="outline"
                  className={styles.cta}
                  onClick={() => void manage()}
                  disabled={pending !== null}
                >
                  Cambia piano
                </Button>
              ) : (
                <div className={styles.ctaGroup}>
                  {state.enabled ? (
                    <Button
                      type="button"
                      className={styles.cta}
                      onClick={() => void subscribe(plan.id as PaidPlanId, 'stripe')}
                      disabled={pending !== null}
                    >
                      {pending === `stripe:${plan.id}`
                        ? 'Apertura del pagamento…'
                        : `Abbonati a ${plan.name}`}
                    </Button>
                  ) : null}
                  {state.paypalEnabled ? (
                    <Button
                      type="button"
                      variant="outline"
                      className={styles.cta}
                      onClick={() => void subscribe(plan.id as PaidPlanId, 'paypal')}
                      disabled={pending !== null}
                    >
                      {pending === `paypal:${plan.id}` ? 'Apertura di PayPal…' : 'Paga con PayPal'}
                    </Button>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {state && !state.paypalEnabled && !current ? (
        <div className={styles.paypalLink}>
          <Button asChild variant="outline">
            <a href={PAYPAL_PAYMENT_LINK} target="_blank" rel="noopener noreferrer">
              Paga con PayPal
            </a>
          </Button>
          <p className={styles.payNote}>
            Il pagamento si apre sulla pagina sicura di PayPal. Usa la stessa email del tuo account
            Solco: l’attivazione di Premium viene fatta a mano dopo la conferma del pagamento.
          </p>
        </div>
      ) : null}
      {state?.enabled || state?.paypalEnabled ? (
        <p className={styles.payNote}>
          Pagamento sicuro con Stripe (carta, Apple Pay, Google Pay) o PayPal. Disdici quando vuoi.
        </p>
      ) : null}
    </>
  );
}
