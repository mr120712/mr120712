// @polsia:user-owned — ritorno da PayPal dopo l'approvazione dell'abbonamento.
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PlanConfirm } from '@/components/custom/plan-confirm';
import styles from '../piani.module.css';

export const metadata: Metadata = { title: 'Abbonamento PayPal', robots: { index: false } };

export default function PayPalReturnPage() {
  return (
    <main className={`${styles.page} ${styles.grazie}`}>
      <Suspense>
        <PlanConfirm provider="paypal" />
      </Suspense>
    </main>
  );
}
