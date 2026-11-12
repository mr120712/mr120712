// @polsia:user-owned
import type { Metadata } from 'next';
import { RecordPool } from '@/components/custom/music/record-pool';

export const metadata: Metadata = {
  title: 'Record Pool',
  description:
    'Un pool di brani royalty-free che gli artisti hanno reso scaricabili (Open Music License): ascoltali e scaricali dentro Solco.',
  alternates: { canonical: '/pool' },
};

export default function PoolPage() {
  return <RecordPool />;
}
