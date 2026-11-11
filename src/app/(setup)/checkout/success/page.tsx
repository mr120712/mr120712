// @polsia:user-owned
import type { Metadata } from 'next';
import { SolcoProCheckoutStatus } from '@/components/custom/solco-pro-checkout-status';
import styles from '../checkout.module.css';

export const metadata: Metadata = {
  title: 'Verifica accesso Solco Pro',
  description: 'Lo stato Solco Pro viene mostrato solo dopo una verifica server-side dell’account.',
};

export default function CheckoutSuccessPage() {
  return (
    <main className={styles.page}>
      <SolcoProCheckoutStatus />
    </main>
  );
}
