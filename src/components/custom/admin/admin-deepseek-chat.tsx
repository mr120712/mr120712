// @polsia:user-owned
'use client';

import { BrainCircuit, RotateCcw, SendHorizontal, ShieldCheck } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import {
  type DeepseekChatMessage,
  DeepseekChatResponseSchema,
} from '@/lib/contracts/deepseek-chat';

interface DisplayMessage extends DeepseekChatMessage {
  id: string;
}

const errorMessages: Record<string, string> = {
  worker_not_configured:
    'Nessun backend IA: imposta MWAPI_API_KEY (o MWAPI_API_KEY_2) su Vercel, oppure scegli altri provider con DEEPSEEK_SOLCO_PROVIDERS.',
  worker_unauthorized:
    'Il worker rifiuta la chiave: imposta WORKER_API_KEY su Render uguale a YTDLP_SERVICE_KEY.',
  chat_not_configured: 'Sul worker manca DEEPSEEK_ENDPOINT_URL (Render → Environment).',
  busy: 'Il worker ha già troppe richieste in corso. Riprova fra qualche secondo.',
  model_unreachable: 'Il server DeepSeek non risponde. Controlla che sia acceso e raggiungibile.',
  timeout: 'Il modello non ha risposto in tempo. Riprova, o chiedi una risposta più breve.',
  model_error: 'Il server DeepSeek ha restituito un errore.',
  bad_response: 'Risposta non valida dal server DeepSeek.',
  rate_limited: 'Hai inviato molte richieste di recente. Attendi un momento.',
  unauthorized: 'Sessione scaduta: accedi di nuovo.',
  forbidden: 'Solo gli amministratori verificati possono usare questa chat.',
};

function errorMessage(error: unknown): string {
  // apiFetch lancia un Error con il corpo JSON della risposta in `cause`.
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause && typeof cause === 'object' && 'error' in cause ? String(cause.error) : undefined;
  if (code && errorMessages[code]) return errorMessages[code];
  return 'Richiesta non riuscita. Riprova.';
}

export function AdminDeepseekChat() {
  const inputId = useId();
  const systemId = useId();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [system, setSystem] = useState('You are a helpful assistant.');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    if (!content || pending) return;

    const history = [
      ...messages,
      { id: crypto.randomUUID(), role: 'user' as const, content },
    ].slice(-40);
    setMessages(history);
    setInput('');
    setProblem(null);
    setPending(true);

    try {
      const result = await apiFetch('/api/admin/deepseek', {
        method: 'POST',
        body: JSON.stringify({
          system: system.trim() || undefined,
          messages: history.map(({ role, content: text }) => ({ role, content: text })),
        }),
        schema: DeepseekChatResponseSchema,
      });
      setMessages([
        ...history,
        { id: crypto.randomUUID(), role: 'assistant', content: result.reply },
      ]);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid min-h-[32rem] min-w-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <BrainCircuit aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold">DeepSeek V4.1 Flash</h2>
          <p className="truncate text-xs text-muted-foreground">MWAPI · Riserva AI di Solco</p>
        </div>
        <span className="ml-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <ShieldCheck aria-hidden="true" className="size-4 text-primary" />
          Solo admin
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Nuova conversazione"
          disabled={pending || messages.length === 0}
          onClick={() => {
            setMessages([]);
            setProblem(null);
          }}
        >
          <RotateCcw aria-hidden="true" className="size-4" />
        </Button>
      </header>

      <div className="grid gap-1.5 border-b border-border/70 px-5 py-3">
        <label htmlFor={systemId} className="text-xs font-medium text-muted-foreground">
          Prompt di sistema
        </label>
        <Textarea
          id={systemId}
          value={system}
          onChange={(event) => setSystem(event.currentTarget.value)}
          maxLength={4000}
          rows={1}
          disabled={pending}
          className="min-h-9 resize-y text-sm"
        />
      </div>

      <div className="grid content-start gap-4 overflow-y-auto p-4 sm:p-5" aria-live="polite">
        {messages.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-5 text-sm leading-6 text-muted-foreground">
            Scrivi un messaggio per iniziare. La conversazione resta solo in questa pagina.
          </p>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={
                message.role === 'user'
                  ? 'ml-auto max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground sm:max-w-[85%]'
                  : 'mr-auto max-w-[96%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-4 py-3 text-sm leading-6 text-foreground sm:max-w-[90%]'
              }
            >
              {message.content}
            </article>
          ))
        )}
        {pending ? (
          <p className="mr-auto rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground">
            DeepSeek sta scrivendo…
          </p>
        ) : null}
        {problem ? (
          <p
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm leading-6 text-destructive"
            role="alert"
          >
            {problem}
          </p>
        ) : null}
      </div>

      <form className="grid gap-2 border-t border-border/70 p-4 sm:p-5" onSubmit={submit}>
        <label htmlFor={inputId} className="sr-only">
          Messaggio per DeepSeek
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
            maxLength={8000}
            rows={2}
            placeholder="Scrivi un messaggio…"
            disabled={pending}
            className="min-h-12 resize-y text-sm"
          />
          <Button type="submit" size="icon" disabled={pending || !input.trim()} aria-label="Invia">
            <SendHorizontal aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Invio per inviare · Maiusc+Invio per andare a capo.
        </p>
      </form>
    </section>
  );
}
