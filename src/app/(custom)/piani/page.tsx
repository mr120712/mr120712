// @polsia:user-owned — pagina dei piani Solco (Free, Premium, Premium Plus, Family).
import type { Metadata } from 'next';
import { PlanSubscribe } from '@/components/custom/plan-subscribe';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';
import styles from './piani.module.css';

export const metadata: Metadata = {
  title: 'Piani',
  description: 'Confronta i piani Solco: Free, Premium, Premium Plus e Family.',
  alternates: { canonical: '/piani' },
};

const freeBenefits = [
  'Brani e video da YouTube nel player Solco',
  'Anteprime di 30 secondi di radio, podcast e catalogo globale Jamendo',
  'Libreria con playlist, cartelle e cronologia',
];

const proBenefits = ['Statistiche avanzate', 'Temi extra', 'Card senza logo', 'Creazione di brani'];

const faq = [
  {
    q: 'Come vengo addebitato?',
    a: 'All’inizio dell’abbonamento e poi a ogni rinnovo, ogni mese o ogni anno secondo il periodo scelto. Con Stripe trovi ricevute e fatture in “Gestisci abbonamento”; con PayPal nel tuo account PayPal.',
  },
  {
    q: 'Posso disdire quando voglio?',
    a: 'Sì, in qualsiasi momento: da “Gestisci abbonamento” (Stripe) o dal tuo account PayPal. Premium resta attivo fino alla fine del periodo già pagato e non ci sono altri addebiti.',
  },
  {
    q: 'Quali metodi di pagamento accettate?',
    a: 'Carte di credito e di debito, Apple Pay e Google Pay tramite Stripe, oppure PayPal.',
  },
  {
    q: 'Posso cambiare piano?',
    a: 'Sì. Con Stripe lo fai da “Gestisci abbonamento”; con PayPal disdici il piano attuale dal tuo account PayPal e ti abboni a quello nuovo.',
  },
  {
    q: 'Ci sono pubblicità?',
    a: 'Solco non mostra pubblicità. I brani del catalogo globale Premium sono senza annunci; i video YouTube possono includere gli annunci di YouTube, che spariscono se hai YouTube Premium.',
  },
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
            plan.monthlyEuroCents === 0
              ? freeBenefits
              : ['Tutto quello che c’è in Free', ...proBenefits],
        }))}
      />

      <section className={styles.faq} aria-labelledby="faq-heading">
        <h2 id="faq-heading">Domande frequenti</h2>
        {faq.map((item) => (
          <details key={item.q}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </section>
    </main>
  );
}
