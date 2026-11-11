// @polsia:user-owned
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PlanConfirm } from '@/components/custom/plan-confirm';
import styles from '../piani.module.css';

export const metadata: Metadata = { title: 'Abbonamento', robots: { index: false } };

export default function ThanksPage() {
  return (
    <main className={`${styles.page} ${styles.grazie}`}>
      <Suspense>
        <PlanConfirm />
      </Suspense>
    </main>
  );
}
