// @polsia:user-owned
import type { Metadata } from 'next';
import { MessagesInbox } from '@/components/custom/messages/messages-inbox';

export const metadata: Metadata = {
  title: 'Messaggi — Solco',
  description: 'Le tue conversazioni private con fan e artisti su Solco.',
};

export default function MessagesPage() {
  return <MessagesInbox />;
}
