// @polsia:user-owned — pagina dei piani Solco (Free, Premium, Premium Plus, Family).
import type { Metadata } from 'next';
import { PlanSubscribe } from '@/components/custom/plan-subscribe';
import { SolcoProPurchase } from '@/components/custom/solco-pro-purchase';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';
import styles from './piani.module.css';

export const metadata: Metadata = {
  title: 'Piani',
  description: 'Confronta i piani Solco: Free, Premium, Premium Plus e Family.',
  alternates: { canonical: '/piani' },
};

const freeBenefits = [
  'Brani e video da YouTube nel player Solco',
  'Radio dal vivo e podcast',
  'Libreria con playlist, cartelle e cronologia',
];

const proBenefits = [
  'Musica globale senza pubblicità: brani completi dal catalogo Jamendo',
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

      <PlanSubscribe
        plans={plans.map((plan) => ({
          id: plan.id,
          name: plan.name,
          monthlyEuroCents: plan.monthlyEuroCents,
          annualEuroCents: plan.annualEuroCents,
          annualSavingsEuroCents: plan.annualSavingsEuroCents,
          benefits:
            plan.monthlyEuroCents === 0 ? freeBenefits : [freeBenefits[0] ?? '', ...proBenefits],
        }))}
      />

      <details className={styles.purchase}>
        <summary>Preferisci un pagamento singolo? Solco Pro per un mese</summary>
        <SolcoProPurchase />
      </details>
    </main>
  );
}
