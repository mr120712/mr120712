// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import {
  type MessageConversationSummary,
  MessagesInboxResponseSchema,
} from '@/lib/contracts/messages';
import styles from './messages.module.css';

function roleName(role: 'fan' | 'artist') {
  return role === 'artist' ? 'Artista' : 'Fan';
}

function lastActive(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function MessagesInbox() {
  const { data: session, isPending: sessionPending } = useSession();
  const [conversations, setConversations] = useState<MessageConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const result = await apiFetch('/api/messages', { schema: MessagesInboxResponseSchema });
      setConversations(result.conversations);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>SOLCO · PRIVATO</p>
          <h1 className={styles.title}>Messaggi</h1>
          <p className={styles.subtitle}>Conversazioni solo tra te e l’altra persona.</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/community">Trova un profilo</Link>
        </Button>
      </header>

      {loading ? (
        <output className={styles.state}>Caricamento conversazioni…</output>
      ) : error ? (
        <section className={styles.emptyState} role="alert">
          {!sessionPending && !session?.user ? (
            <>
              <h2>Accedi per aprire l’inbox</h2>
              <p>Dopo l’accesso tornerai alle tue conversazioni.</p>
              <Button asChild>
                <Link href={`/login?callbackURL=${encodeURIComponent('/messages')}`}>Accedi</Link>
              </Button>
            </>
          ) : (
            <>
              <h2>Messaggi non disponibili</h2>
              <p>Non siamo riusciti a caricare la tua inbox.</p>
              <Button type="button" variant="outline" onClick={() => void load()}>
                Riprova
              </Button>
            </>
          )}
        </section>
      ) : conversations.length === 0 ? (
        <section className={styles.emptyState}>
          <span className={styles.emptyMark} aria-hidden="true">
            S
          </span>
          <h2>La tua inbox è vuota</h2>
          <p>Apri un profilo pubblico della community e invia il primo messaggio.</p>
          <Button asChild>
            <Link href="/community">Esplora la community</Link>
          </Button>
        </section>
      ) : (
        <ul className={styles.conversationList} aria-label="Le tue conversazioni">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <Link
                className={styles.conversationRow}
                href={`/messages/${encodeURIComponent(conversation.id)}`}
              >
                <span className={styles.avatar} aria-hidden="true">
                  {conversation.participant.name.trim().charAt(0).toLocaleUpperCase('it-IT') || 'S'}
                </span>
                <span className={styles.conversationCopy}>
                  <span className={styles.conversationTopline}>
                    <strong>{conversation.participant.name}</strong>
                    <time dateTime={conversation.lastMessage.createdAt}>
                      {lastActive(conversation.lastMessage.createdAt)}
                    </time>
                  </span>
                  <span className={styles.role}>{roleName(conversation.participant.role)}</span>
                  <span className={styles.preview}>{conversation.lastMessage.content}</span>
                </span>
                <span className={styles.chevron} aria-hidden="true">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
