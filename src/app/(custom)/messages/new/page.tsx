// @polsia:user-owned
import type { Metadata } from 'next';
import { NewMessage } from '@/components/custom/messages/new-message';

export const metadata: Metadata = {
  title: 'Nuovo messaggio — Solco',
  description: 'Inizia una conversazione privata con un profilo della community Solco.',
};

export default async function NewMessagePage({
  searchParams,
}: {
  searchParams: Promise<{ profile?: string }>;
}) {
  const { profile } = await searchParams;
  return <NewMessage profileId={profile ?? ''} />;
}
