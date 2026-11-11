// @polsia:user-owned — pagina dei piani Solco (Free, Premium, Premium Plus, Family).
import { Check } from 'lucide-react';
import type { Metadata } from 'next';
import { SolcoProPurchase } from '@/components/custom/solco-pro-purchase';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';
import styles from './piani.module.css';

export const metadata: Metadata = {
  title: 'Piani',
  description: 'Confronta i piani Solco: Free, Premium, Premium Plus e Family.',
  alternates: { canonical: '/piani' },
};

const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });

const freeBenefits = [
  'Ricerca su Audius e YouTube',
  'Radio dal vivo e podcast',
  'Libreria con playlist, cartelle e cronologia',
];

const proBenefits = [
  'Ascolto integrale dei brani con diritti verificati',
  'Statistiche avanzate',
  'Temi extra',
  'Card senza logo',
  'Creazione di brani',
];

export default function PlansPage() {
  const { plans } = getSolcoProPricing();
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>PIANI</p>
        <h1>Scegli il tuo piano</h1>
        <p className={styles.lead}>Prezzi in euro. Puoi pagare al mese o all’anno.</p>
      </header>

      <ul className={styles.grid}>
        {plans.map((plan) => {
          const free = plan.monthlyEuroCents === 0;
          return (
            <li key={plan.id} className={styles.card} data-plan={plan.id}>
              <h2>{plan.name}</h2>
              {free ? (
                <p className={styles.price}>
                  <strong>Gratis</strong>
                </p>
              ) : (
                <>
                  <p className={styles.price}>
                    <strong>{euro.format(plan.monthlyEuroCents / 100)}</strong>
                    <span>/mese</span>
                  </p>
                  <p className={styles.annual}>
                    oppure {euro.format(plan.annualEuroCents / 100)}/anno · risparmi{' '}
                    {euro.format(plan.annualSavingsEuroCents / 100)}
                  </p>
                </>
              )}
              <ul className={styles.benefits}>
                {(free ? freeBenefits : [...freeBenefits.slice(0, 1), ...proBenefits]).map(
                  (benefit) => (
                    <li key={benefit}>
                      <Check aria-hidden="true" />
                      {benefit}
                    </li>
                  ),
                )}
              </ul>
              {free ? null : <p className={styles.soon}>Abbonamento in arrivo</p>}
            </li>
          );
        })}
      </ul>

      <section className={styles.purchase} aria-labelledby="pro-now-heading">
        <h2 id="pro-now-heading">Solco Pro oggi</h2>
        <p className={styles.lead}>
          Gli abbonamenti mensili e annuali non sono ancora attivi. Intanto puoi attivare Solco Pro
          con il pagamento singolo qui sotto, quando è disponibile.
        </p>
        <SolcoProPurchase />
      </section>
    </main>
  );
}
