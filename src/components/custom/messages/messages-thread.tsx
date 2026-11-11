// @polsia:user-owned
'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { requestErrorMessage } from '@/lib/business/request-error-message';
import {
  type MessageItem,
  MessageMutationResponseSchema,
  MessageThreadResponseSchema,
} from '@/lib/contracts/messages';
import styles from './messages.module.css';

function displayTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function MessagesThread({ conversationId }: { conversationId: string }) {
  const { data: session, isPending: sessionPending } = useSession();
  const [currentUserId, setCurrentUserId] = useState('');
  const [participant, setParticipant] = useState<{
    id: string;
    name: string;
    role: 'fan' | 'artist';
  } | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const [sendError, setSendError] = useState('');
  const endRef = useRef<HTMLLIElement | null>(null);
  const lastMessageId = messages[messages.length - 1]?.id;

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const result = await apiFetch(`/api/messages/${encodeURIComponent(conversationId)}`, {
        schema: MessageThreadResponseSchema,
      });
      setCurrentUserId(result.currentUserId);
      setParticipant(result.conversation.participant);
      setMessages(result.messages);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (lastMessageId) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [lastMessageId]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || !content.trim()) return;
    setSending(true);
    setSendError('');
    try {
      const result = await apiFetch(`/api/messages/${encodeURIComponent(conversationId)}`, {
        method: 'POST',
        body: JSON.stringify({ content }),
        schema: MessageMutationResponseSchema,
      });
      setMessages((current) => [...current, result.message]);
      setContent('');
    } catch (caught) {
      setSendError(
        requestErrorMessage(caught, 'Messaggio non inviato. Il testo è ancora qui: riprova.'),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.threadHeader}>
        <Button asChild variant="outline" size="sm">
          <Link href="/messages">Inbox</Link>
        </Button>
        <div className={styles.threadIdentity}>
          <span className={styles.avatar} aria-hidden="true">
            {participant?.name.trim().charAt(0).toLocaleUpperCase('it-IT') || 'S'}
          </span>
          <div>
            <h1>{participant?.name ?? 'Conversazione'}</h1>
            {participant ? (
              <span className={styles.role}>
                {participant.role === 'artist' ? 'Artista' : 'Fan'}
              </span>
            ) : null}
          </div>
        </div>
        <span className={styles.privateNote}>Privata</span>
      </header>

      {loading ? <output className={styles.state}>Caricamento messaggi…</output> : null}
      {error ? (
        <section className={styles.emptyState} role="alert">
          {!sessionPending && !session?.user ? (
            <>
              <h2>Accedi per leggere questa chat</h2>
              <p>Dopo l’accesso tornerai alla conversazione richiesta.</p>
              <Button asChild>
                <Link
                  href={`/login?callbackURL=${encodeURIComponent(`/messages/${conversationId}`)}`}
                >
                  Accedi
                </Link>
              </Button>
            </>
          ) : (
            <>
              <h2>Conversazione non disponibile</h2>
              <p>Verifica di avere effettuato l’accesso con uno dei due account.</p>
              <Button type="button" variant="outline" onClick={() => void load()}>
                Riprova
              </Button>
            </>
          )}
        </section>
      ) : !loading && participant ? (
        <>
          <ol className={styles.messageList} aria-label={`Messaggi con ${participant.name}`}>
            {messages.map((message) => {
              const own = message.senderId === currentUserId;
              return (
                <li className={own ? styles.messageRowOwn : styles.messageRow} key={message.id}>
                  <article className={own ? styles.messageOwn : styles.message}>
                    <p>{message.content}</p>
                    <time dateTime={message.createdAt}>{displayTime(message.createdAt)}</time>
                  </article>
                </li>
              );
            })}
            <li ref={endRef} aria-hidden="true" />
          </ol>
          <form className={styles.threadComposer} onSubmit={send}>
            <label className="sr-only" htmlFor="reply-message">
              Scrivi un messaggio
            </label>
            <textarea
              id="reply-message"
              className={styles.replyInput}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              maxLength={5000}
              rows={2}
              placeholder="Scrivi un messaggio…"
              required
            />
            <Button type="submit" disabled={sending || !content.trim()}>
              {sending ? 'Invio…' : 'Invia'}
            </Button>
            {sendError ? (
              <p className={styles.error} role="alert">
                {sendError}
              </p>
            ) : null}
          </form>
        </>
      ) : null}
    </main>
  );
}
