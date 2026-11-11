// @polsia:user-owned
'use client';

import { Bot, SendHorizontal, ShieldCheck } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import { adminAssistantErrorMessage } from '@/lib/business/admin-assistant';
import {
  type AdminAssistantMessage,
  AdminAssistantResponseSchema,
} from '@/lib/contracts/admin-assistant';

interface DisplayMessage extends AdminAssistantMessage {
  id: string;
}

const suggestions = [
  'Come registro una nuova fonte per un brano?',
  'Quali informazioni servono per verificare una prova dei diritti?',
  'Quali dati amministrativi puoi controllare?',
];

export function AdminAssistant() {
  const inputId = useId();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    if (!content || pending) return;

    const userMessage: DisplayMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
    };
    const history = [...messages, userMessage].slice(-24);
    setMessages(history);
    setInput('');
    setUnavailable(null);
    setPending(true);

    try {
      const result = await apiFetch('/api/admin/assistant', {
        method: 'POST',
        body: JSON.stringify({
          messages: history.map(({ role, content: messageContent }) => ({
            role,
            content: messageContent,
          })),
        }),
        schema: AdminAssistantResponseSchema,
      });
      const assistantMessage: DisplayMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.reply,
      };
      setMessages([...history, assistantMessage]);
    } catch (error) {
      setUnavailable(adminAssistantErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid min-h-[32rem] min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bot aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold">Assistente admin</h2>
          <p className="text-xs text-muted-foreground">IA Polsia · solo dati autorizzati</p>
        </div>
        <span className="ml-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <ShieldCheck aria-hidden="true" className="size-4 text-primary" />
          Sessione admin verificata
        </span>
      </header>

      <div className="grid content-start gap-4 overflow-y-auto p-4 sm:p-5" aria-live="polite">
        {messages.length === 0 ? (
          <div className="grid gap-3 rounded-lg border border-dashed border-border p-5">
            <p className="text-sm leading-6 text-muted-foreground">
              Descrivi il problema e separa i fatti osservati dalle ipotesi. Indicherò su quali
              informazioni mi baso e cosa non posso verificare.
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setInput(suggestion)}
                  className="rounded-full border border-border px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={
                message.role === 'user'
                  ? 'ml-auto max-w-[92%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground sm:max-w-[85%]'
                  : 'mr-auto max-w-[96%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-4 py-3 text-sm leading-6 text-foreground sm:max-w-[90%]'
              }
            >
              {message.content}
            </article>
          ))
        )}
        {pending ? (
          <p className="mr-auto rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground">
            Sto analizzando le informazioni autorizzate…
          </p>
        ) : null}
        {unavailable ? (
          <p
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm leading-6 text-destructive"
            role="alert"
          >
            {unavailable}
          </p>
        ) : null}
      </div>

      <form className="grid gap-2 border-t border-border/70 p-4 sm:p-5" onSubmit={submit}>
        <label htmlFor={inputId} className="sr-only">
          Messaggio per l’assistente
        </label>
        <div className="flex items-end gap-2">
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
            maxLength={4000}
            rows={2}
            placeholder="Descrivi il problema…"
            disabled={pending}
            className="min-h-12 resize-y text-sm"
          />
          <Button
            type="submit"
            size="icon"
            disabled={pending || !input.trim()}
            aria-label="Invia messaggio"
          >
            <SendHorizontal aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Non inserire password, token, chiavi API o altri segreti. Invio per inviare · Maiusc+Invio
          per andare a capo.
        </p>
      </form>
    </section>
  );
}
