// @polsia:user-owned
'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  getSolcoProDisplayedPrice,
  type SolcoProBillingPeriod,
} from '@/lib/business/solco-pro-pricing';
import {
  type SolcoFreePlanSelection,
  solcoPlanSelectionResponseSchema,
} from '@/lib/contracts/solco-plan-selection';
import { type SolcoProPricing, solcoProPricingSchema } from '@/lib/contracts/solco-pro-pricing';
import styles from './solco-pro-subscription.module.css';

function formatEuro(cents: number, alwaysShowCents = false) {
  const euros = Math.floor(cents / 100);
  const remainder = cents % 100;
  if (remainder === 0 && !alwaysShowCents) return `${euros} €`;
  return `${euros},${String(remainder).padStart(2, '0')} €`;
}

function formatPlanPrice(cents: number, period: SolcoProBillingPeriod) {
  return `${formatEuro(cents)}${period === 'month' ? '/mese' : '/anno'}`;
}

export function SolcoProPlanOptions() {
  const [pricing, setPricing] = useState<SolcoProPricing | null>(null);
  const [period, setPeriod] = useState<SolcoProBillingPeriod>('month');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selection, setSelection] = useState<SolcoFreePlanSelection | null>(null);
  const [selectionUnavailable, setSelectionUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);

  async function selectFreePlan() {
    setSaving(true);
    try {
      const result = await apiFetch('/api/solco-pro/plan-selection', {
        method: 'POST',
        body: JSON.stringify({ planId: 'free', billingPeriod: period }),
        schema: solcoPlanSelectionResponseSchema,
      });
      setSelection(result.selection);
      setSelectionUnavailable(false);
      toast.success('Piano Free aggiornato. Nessun addebito è stato avviato.');
    } catch {
      toast.error('La scelta Free non è stata salvata. Riprova più tardi.');
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    let current = true;
    apiFetch('/api/solco-pro/plans', { schema: solcoProPricingSchema })
      .then((result) => {
        if (current) setPricing(result);
      })
      .catch(() => {
        if (current) setError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    apiFetch('/api/solco-pro/plan-selection', { schema: solcoPlanSelectionResponseSchema })
      .then((result) => {
        if (current) {
          setSelection(result.selection);
          if (result.selection) setPeriod(result.selection.billingPeriod);
        }
      })
      .catch(() => {
        if (current) setSelectionUnavailable(true);
      });

    return () => {
      current = false;
    };
  }, []);

  return (
    <section className={styles.plans} aria-labelledby="solco-pro-plans-title">
      <div className={styles.plansHead}>
        <h3 id="solco-pro-plans-title">Piani</h3>
        <div className={styles.billingControl}>
          <span className={styles.billingLabel} aria-hidden="true">
            Mensile / Annuale
          </span>
          <fieldset className={styles.billingPeriod}>
            <legend>Mensile / Annuale</legend>
            <label className={styles.billingChoice}>
              <input
                type="radio"
                name="solco-pro-billing-period"
                value="month"
                checked={period === 'month'}
                onChange={() => setPeriod('month')}
              />
              <span>Mensile</span>
            </label>
            <label className={styles.billingChoice}>
              <input
                type="radio"
                name="solco-pro-billing-period"
                value="year"
                checked={period === 'year'}
                onChange={() => setPeriod('year')}
              />
              <span>Annuale</span>
            </label>
          </fieldset>
        </div>
      </div>

      {loading ? <output className={styles.state}>Caricamento dei piani…</output> : null}
      {error ? (
        <p className={styles.error} role="alert">
          Non è stato possibile caricare i prezzi dei piani.
        </p>
      ) : null}

      {pricing ? (
        <>
          <p className={styles.selectionStatus} aria-live="polite">
            {selection
              ? `Piano Free ${selection.billingPeriod === 'month' ? 'mensile' : 'annuale'} selezionato: 0 €. Nessun rinnovo o addebito.`
              : selectionUnavailable
                ? 'La scelta del piano salvata non è verificabile in questo momento.'
                : 'Non hai ancora selezionato il piano Free.'}
          </p>
          <div className={styles.planGrid}>
            {pricing.plans.map((plan) => {
              const selectedAmount = getSolcoProDisplayedPrice(plan, period);
              const freePlanSelected = plan.id === 'free' && selection?.billingPeriod === period;
              return (
                <article className={styles.planCard} data-plan-id={plan.id} key={plan.id}>
                  <h4>{plan.name}</h4>
                  <p className={styles.selectedPrice} aria-live="polite">
                    {formatPlanPrice(selectedAmount, period)}
                  </p>
                  <p className={styles.priceOptions}>
                    Mensile: {formatPlanPrice(plan.monthlyEuroCents, 'month')} · Annuale:{' '}
                    {formatPlanPrice(plan.annualEuroCents, 'year')}
                  </p>
                  {period === 'year' ? (
                    <div className={styles.annualSavings}>
                      <p>Dodici mensilità: {formatEuro(plan.twelveMonthlyEuroCents, true)}</p>
                      <p>
                        <strong>Risparmia con il piano annuale:</strong>{' '}
                        {formatEuro(plan.annualSavingsEuroCents, true)}
                      </p>
                    </div>
                  ) : null}
                  <div className={styles.planActions}>
                    {plan.id === 'free' ? (
                      <Button
                        type="button"
                        variant={freePlanSelected ? 'secondary' : 'default'}
                        disabled={saving || freePlanSelected}
                        onClick={() => void selectFreePlan()}
                      >
                        {saving
                          ? 'Salvataggio…'
                          : freePlanSelected
                            ? 'Piano selezionato'
                            : `Scegli Free · ${period === 'month' ? 'mensile' : 'annuale'}`}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        disabled
                        aria-describedby="solco-pro-payment-limit"
                      >
                        Checkout non disponibile
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <p className={styles.planMapping}>
            La matrice delle funzionalità e dei limiti per questi quattro piani non è disponibile.
            Le regole di accesso Solco Pro esistenti restano invariate; non assegniamo i benefit
            attuali a nuovi piani.
          </p>
          <div className={styles.paymentNotice}>
            <strong>Prezzi mostrati, non prezzi Stripe confermati.</strong>
            <p id="solco-pro-payment-limit">
              Non risultano mappature Stripe ricorrenti in EUR. stripe-billing 0.8.0 usa importi USD
              e non verifica prezzi, addebiti o rinnovi in EUR. Restano da completare le verifiche
              legali, fiscali e del provider.
            </p>
            <p>
              Gli acquisti a pagamento e i cambi di piano o cadenza non sono disponibili. La scelta
              Free viene salvata solo per il tuo account e non avvia Stripe. Non cancella né
              modifica eventuali contratti pagati preesistenti, che mantengono le condizioni e la
              validità già verificate. Il selettore cambia il prezzo visualizzato finché non
              confermi esplicitamente una scelta.
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}
