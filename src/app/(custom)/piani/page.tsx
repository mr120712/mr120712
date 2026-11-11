// @polsia:user-owned — pagina dei piani Solco (Free, Premium, Premium Plus, Family).
import type { Metadata } from 'next';
import Link from 'next/link';
import { PlanSubscribe } from '@/components/custom/plan-subscribe';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';
import styles from './piani.module.css';

export const metadata: Metadata = {
  title: 'Piani',
  description: 'Confronta i piani Solco: Free, Premium, Premium Plus e Family.',
  alternates: { canonical: '/piani' },
};

const freeBenefits = [
  '40 ascolti al mese con un account gratuito',
  'Brani e video da YouTube nel player Solco',
  'Radio dal vivo da tutto il mondo, complete e anche in background',
  'Brani completi del catalogo Jamendo e podcast, anche in background',
  'Libreria con playlist, cartelle e cronologia',
];

const proBenefits = [
  'Ascolti illimitati',
  'Nessun limite mensile su podcast e catalogo globale Jamendo, senza pubblicità',
  'Ascolto illimitato in background: continua a schermo bloccato o in un’altra app',
  'Statistiche avanzate',
  'Temi extra',
  'Card senza logo',
  'Creazione di brani',
];

const faq = [
  {
    q: 'Come funziona la prova gratuita di 10 giorni?',
    a: 'Al primo abbonamento hai 10 giorni di Premium gratis. Inserisci subito carta o PayPal, ma il primo addebito arriva solo alla fine della prova; se disdici prima non paghi nulla. La prova vale una sola volta per account.',
  },
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

      <p className={styles.lead}>
        Vuoi Premium gratis? <Link href="/premi#invita">Invita amici, ottieni Premium gratis</Link>:
        30 giorni a entrambi per ogni amico che si abbona, fino a 12 mesi.
      </p>

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
