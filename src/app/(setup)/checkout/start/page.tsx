// @polsia:user-owned
import type { Metadata } from 'next';
import { SolcoProCheckoutStart } from '@/components/custom/solco-pro-checkout-start';
import styles from '../checkout.module.css';

export const metadata: Metadata = {
  title: 'Checkout Solco Pro · Stripe',
  description: 'Pagamento Stripe una tantum di 24,00 EUR per un mese di Solco Pro.',
};

export default function CheckoutStartPage() {
  return (
    <main className={styles.page}>
      <SolcoProCheckoutStart />
    </main>
  );
}
