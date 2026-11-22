'use client';
// @polsia:user-owned — la chat di «Skynet» nel pannello in Amministrazione → Monitoraggio. Il
// proprietario scrive una domanda; il server cerca in tutte le fonti di Skynet e risponde
// (POST /api/admin/skynet/chat). Sotto ogni risposta si legge chi l'ha scritta e quali fonti sono
// state lette. La conversazione resta solo in questa pagina: non viene salvata.

import { Radar, SendHorizontal } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import {
  SKYNET_CHAT_MAX_QUESTION,
  SKYNET_CHAT_MAX_TURNS,
  SKYNET_CHAT_SUGGESTIONS,
  type SkynetChatResponse,
  SkynetChatResponseSchema,
} from '@/lib/contracts/skynet-chat';
import styles from './skynet-chat.module.css';

const ENDPOINT = '/api/admin/skynet/chat';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Solo sulle risposte: chi ha scritto e con quali fonti. */
  meta?: Pick<SkynetChatResponse, 'engine' | 'model' | 'sources' | 'missing'>;
};

const ENGINE_LABELS: Record<SkynetChatResponse['engine'], string> = {
  gpt6: 'Risposta di GPT-6',
  claude: 'Risposta di Claude',
  reserve: 'Risposta della riserva AI (GPT-6 e Claude non erano raggiungibili)',
  facts: 'Solo fatti: nessuna AI raggiungibile in questo momento',
  command: 'Comando eseguito da Skynet, senza AI',
};

/** Cosa dire quando la domanda non è andata a buon fine. */
export function chatErrorMessage(error: unknown): string {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; message?: unknown })
      : null;
  const code = typeof cause?.error === 'string' ? cause.error : '';
  if (code === 'unauthorized' || code === 'forbidden') {
    return 'La sessione non è più valida per parlare con Skynet. Acceda di nuovo con l’account amministratore.';
  }
  if (code.startsWith('rate_limit') && typeof cause?.message === 'string') return cause.message;
  if (code === 'invalid_request' || code === 'payload_too_large') {
    return 'La domanda è troppo lunga. La accorci e riprovi.';
  }
  return 'Skynet non è riuscito a rispondere. Non è stato cambiato nulla: riprovi fra poco.';
}

/** La riga sotto una risposta: chi l'ha scritta e che cosa è stato letto. */
export function metaText(meta: NonNullable<Message['meta']>): string {
  const parts = [
    meta.model ? `${ENGINE_LABELS[meta.engine]} (${meta.model})` : ENGINE_LABELS[meta.engine],
  ];
  if (meta.sources.length > 0) parts.push(`Fonti lette: ${meta.sources.join(', ')}`);
  if (meta.missing.length > 0) parts.push(`Non lette: ${meta.missing.join(', ')}`);
  return parts.join(' · ');
}

export function SkynetChat({ onCommand }: { onCommand?: () => void }) {
  const inputId = useId();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.length;

  // L'ultima risposta resta in vista senza muovere la pagina.
  useEffect(() => {
    if (count > 0 || pending) endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [count, pending]);

  async function send(text: string) {
    const content = text.trim().slice(0, SKYNET_CHAT_MAX_QUESTION);
    if (!content || pending) return;
    const history: Message[] = [
      ...messages,
      { id: crypto.randomUUID(), role: 'user' as const, content },
    ].slice(-SKYNET_CHAT_MAX_TURNS);
    setMessages(history);
    setInput('');
    setError(null);
    setPending(true);
    try {
      const answer = await apiFetch(ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({
          messages: history.map((message) => ({ role: message.role, content: message.content })),
        }),
        schema: SkynetChatResponseSchema,
      });
      setMessages([
        ...history,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: answer.reply,
          meta: {
            engine: answer.engine,
            model: answer.model,
            sources: answer.sources,
            missing: answer.missing,
          },
        },
      ]);
      // Un comando ha cambiato lo stato dell'autodifesa: il pannello lo rilegge subito.
      if (answer.engine === 'command') onCommand?.();
    } catch (failure) {
      setError(chatErrorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(input);
  }

  return (
    <section className={styles.chat} aria-labelledby={`${inputId}-title`}>
      <header className={styles.header}>
        <Radar aria-hidden="true" className={styles.icon} />
        <div>
          <h3 id={`${inputId}-title`} className={styles.title}>
            Chiedi a Skynet
          </h3>
          <p className={styles.note}>
            Prima di rispondere cerca da solo in tutte le sue fonti: diario, firewall, blocchi,
            controlli interni, deploy, iscritti e visite.
          </p>
        </div>
      </header>

      <div className={styles.transcript} aria-live="polite">
        {messages.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.note}>Provi con una di queste domande, o scriva la sua.</p>
            <div className={styles.suggestions}>
              {SKYNET_CHAT_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className={styles.suggestion}
                  disabled={pending}
                  onClick={() => void send(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <article key={message.id} className={styles.message} data-role={message.role}>
              <p className={styles.author}>{message.role === 'user' ? 'Lei' : 'Skynet'}</p>
              <p className={styles.text}>{message.content}</p>
              {message.meta ? <p className={styles.meta}>{metaText(message.meta)}</p> : null}
            </article>
          ))
        )}
        {pending ? <p className={styles.pending}>Sto cercando in tutte le fonti…</p> : null}
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      <form className={styles.form} onSubmit={submit}>
        <label htmlFor={inputId} className="sr-only">
          Domanda per Skynet
        </label>
        <Textarea
          id={inputId}
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          maxLength={SKYNET_CHAT_MAX_QUESTION}
          rows={2}
          placeholder="Per esempio: ci sono stati attacchi ieri?"
          disabled={pending}
          className={styles.input}
        />
        <Button
          type="submit"
          size="icon"
          disabled={pending || !input.trim()}
          aria-label="Invia la domanda"
        >
          <SendHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </form>
      <p className={styles.note}>
        Skynet legge soltanto: non può cambiare nulla. I soli comandi, riservati al proprietario,
        sono «pausa autodifesa 2 ore» e «riprendi autodifesa», scritti così. Non scriva password o
        chiavi: non le vede e non le chiede. Gli indirizzi IP restano mascherati.
      </p>
    </section>
  );
}
