// @polsia:user-owned
import type { Metadata } from 'next';
import { RadioDirectory } from '@/components/custom/music/radio-directory';

export const metadata: Metadata = {
  title: 'Radio',
  description: 'Ascolta in diretta stazioni radio da tutto il mondo, per genere o per paese.',
  alternates: { canonical: '/radio' },
};

export default async function RadioPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  return (
    <RadioDirectory initialQuery={typeof params.q === 'string' ? params.q.slice(0, 80) : ''} />
  );
}
