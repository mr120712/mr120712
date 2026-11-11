// @polsia:user-owned
import type { Metadata } from 'next';
import { RewardsView } from '@/components/custom/rewards-view';

export const metadata: Metadata = {
  title: 'Premi',
  description: 'Invita amici, ascolta e festeggia: guadagna giorni di Solco Premium gratis.',
  alternates: { canonical: '/premi' },
};

export default function RewardsPage() {
  return <RewardsView />;
}
