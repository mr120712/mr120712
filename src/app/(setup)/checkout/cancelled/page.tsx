// @polsia:user-owned
import type { Metadata } from 'next';
import Link from 'next/link';
import { SOLCO_PRO_CANCELLED_MESSAGE } from '@/lib/business/solco-pro-billing';
import styles from '../checkout.module.css';

export const metadata: Metadata = {
  title: 'Checkout annullato',
  description: 'L’acquisto Solco Pro non è stato confermato.',
};

export default function CheckoutCancelledPage() {
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="cancelled-title">
        <p className={styles.eyebrow}>CHECKOUT INTERROTTO</p>
        <h1 id="cancelled-title">Acquisto non completato</h1>
        <p>{SOLCO_PRO_CANCELLED_MESSAGE}</p>
        <Link className={styles.actionLink} href="/#piani">
          Torna ai prezzi
        </Link>
      </section>
    </main>
  );
}
