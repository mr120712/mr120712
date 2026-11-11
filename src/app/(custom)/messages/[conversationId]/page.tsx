// @polsia:user-owned
import type { Metadata } from 'next';
import { MessagesThread } from '@/components/custom/messages/messages-thread';

export const metadata: Metadata = {
  title: 'Conversazione — Solco',
  description: 'Leggi e invia messaggi privati su Solco.',
};

export default async function MessageThreadPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  return <MessagesThread conversationId={conversationId} />;
}
