// @polsia:user-owned
import type { Metadata } from 'next';
import { RewardsView } from '@/components/custom/rewards-view';

export const metadata: Metadata = {
  title: 'Premi',
  description:
    'Invita amici, ottieni Premium gratis: 30 giorni a entrambi quando un amico si abbona, fino a 12 mesi.',
  alternates: { canonical: '/premi' },
};

export default function RewardsPage() {
  return <RewardsView />;
}
