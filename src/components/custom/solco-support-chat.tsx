// @polsia:user-owned
'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { LifeBuoy, LoaderCircle, MessageCircle, RotateCcw, SendHorizontal, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  SUPPORT_NOT_CONFIGURED,
  SUPPORT_TEMPORARY_ERROR,
} from '@/lib/business/solco-support-policy';
import styles from './solco-support-chat.module.css';

type SupportMessage = { id: string; role: 'user' | 'assistant'; content: string };

function newMessage(role: SupportMessage['role'], content: string): SupportMessage {
  return { id: crypto.randomUUID(), role, content };
}

function responseErrorMessage(body: unknown, status: number): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'message' in body &&
    typeof body.message === 'string'
  ) {
    return body.message;
  }
  if (status === 429) return 'Hai raggiunto il limite di richieste al supporto. Riprova più tardi.';
  if (status === 413) return 'La richiesta è troppo grande. Riduci il testo e riprova.';
  return 'Non è stato possibile inviare la domanda. Riprova più tardi.';
}

export function SolcoSupportChat() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const latestMessageText = messages.at(-1)?.content;

  async function sendQuestion(value: string) {
    const question = value.trim();
    if (!question || pending) return;
    const history = [...messages.slice(-48), newMessage('user', question)];
    setMessages(history);
    setInput('');
    setPending(true);

    try {
      const response = await fetch('/api/solco-support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      if (!response.ok || !response.body) {
        const body: unknown = await response.json().catch(() => null);
        setMessages([
          ...history,
          newMessage('assistant', responseErrorMessage(body, response.status)),
        ]);
        return;
      }

      const assistant = newMessage('assistant', '');
      setMessages([...history, assistant]);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const token: unknown = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof token === 'string') {
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistant.id
                    ? { ...message, content: message.content + token }
                    : message,
                ),
              );
            }
          } catch {
            // Le righe che non sono eventi SSE JSON non aggiungono contenuto.
          }
        }
      }
    } catch {
      setMessages([...history, newMessage('assistant', SUPPORT_TEMPORARY_ERROR)]);
    } finally {
      setPending(false);
    }
  }

  function send() {
    return sendQuestion(input);
  }

  useEffect(() => {
    if (latestMessageText === undefined) return;
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [latestMessageText]);

  const lastMessage = messages.at(-1);
  const retryable =
    lastMessage?.role === 'assistant' &&
    (lastMessage.content === SUPPORT_NOT_CONFIGURED ||
      lastMessage.content === SUPPORT_TEMPORARY_ERROR);
  const lastQuestion = retryable
    ? [...messages.slice(0, -1)].reverse().find((message) => message.role === 'user')?.content
    : undefined;

  if (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/search'
  ) {
    return null;
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          className={`${styles.launcher} solco-support-launcher`}
          type="button"
          aria-label="Apri l’assistenza di Solco"
        >
          <MessageCircle aria-hidden="true" className={styles.launcherIcon} />
          <span className={styles.launcherLabel}>Assistenza</span>
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content className={styles.panel}>
          <header className={styles.header}>
            <span className={styles.brandMark} aria-hidden="true">
              <LifeBuoy />
            </span>
            <div className={styles.headerCopy}>
              <DialogPrimitive.Title className={styles.title}>
                Assistenza Solco
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className={styles.description}>
                Chiedimi come cercare, segnare e ritrovare i tuoi ascolti.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className={styles.close} aria-label="Chiudi assistenza">
              <X aria-hidden="true" />
            </DialogPrimitive.Close>
          </header>

          <div
            className={styles.messages}
            ref={listRef}
            aria-live="polite"
            aria-relevant="additions text"
          >
            {messages.length === 0 ? (
              <div className={`${styles.message} ${styles.assistantMessage}`}>
                Ciao! Posso aiutarti a usare Solco. Per esempio: come registro un ascolto?
              </div>
            ) : (
              messages.map((message) => (
                <div
                  className={`${styles.message} ${
                    message.role === 'user' ? styles.userMessage : styles.assistantMessage
                  }`}
                  key={message.id}
                >
                  {message.content || (pending ? '…' : '')}
                </div>
              ))
            )}
            {pending ? (
              <output className={styles.status} aria-live="polite">
                <LoaderCircle aria-hidden="true" /> Sto preparando una risposta…
              </output>
            ) : null}
            {retryable && lastQuestion ? (
              <button
                className={styles.retry}
                type="button"
                onClick={() => {
                  void sendQuestion(lastQuestion);
                }}
              >
                <RotateCcw aria-hidden="true" /> Riprova la domanda
              </button>
            ) : null}
          </div>

          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              aria-label="Scrivi la tua domanda"
              autoComplete="off"
              maxLength={1200}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="Scrivi una domanda su Solco…"
              rows={2}
              value={input}
            />
            <button
              className={styles.send}
              type="submit"
              disabled={pending || !input.trim()}
              aria-label="Invia domanda"
            >
              <SendHorizontal aria-hidden="true" />
            </button>
          </form>
          <p className={styles.scopeNote}>
            Il supporto risponde solo su Solco e sulle sue funzioni.
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
