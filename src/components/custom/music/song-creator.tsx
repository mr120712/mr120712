// @polsia:user-owned
'use client';

import { AudioLines, CircleAlert, LockKeyhole, Music2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import { createSongRequestSchema } from '@/lib/contracts/music-generation';

const PROMPT_MAX_LENGTH = 1200;

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.cause || typeof error.cause !== 'object')
    return undefined;
  if (!('error' in error.cause) || typeof error.cause.error !== 'string') return undefined;
  return error.cause.error;
}

function unavailableMessage(code: string | undefined) {
  switch (code) {
    case 'pro_required':
    case 'pro_identity_unavailable':
    case 'pro_identity_mismatch':
      return 'Questa funzione e la libreria personale sono riservate a un accesso Solco Pro attivo e verificato.';
    case 'pro_status_unavailable':
    case 'pro_entitlement_unavailable':
      return 'Non è stato possibile verificare il tuo accesso Pro. Riprova più tardi.';
    case 'music_provider_not_configured':
      return 'La creazione musicale non è ancora disponibile: manca un provider musicale autorizzato e configurato. Nessun brano è stato creato.';
    default:
      return 'Non è stato possibile caricare la libreria. Riprova più tardi.';
  }
}

export function SongCreator() {
  const [prompt, setPrompt] = useState('');
  const [checkingLibrary, setCheckingLibrary] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [libraryMessage, setLibraryMessage] = useState('');
  const [submitMessage, setSubmitMessage] = useState('');

  useEffect(() => {
    let current = true;
    apiFetch('/api/music-generation')
      .catch((error: unknown) => {
        if (current) setLibraryMessage(unavailableMessage(errorCode(error)));
      })
      .finally(() => {
        if (current) setCheckingLibrary(false);
      });

    return () => {
      current = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitMessage('');
    const parsedPrompt = createSongRequestSchema.safeParse({ prompt });
    if (!parsedPrompt.success) {
      setSubmitMessage('Aggiungi qualche dettaglio in più: servono almeno 20 caratteri.');
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch('/api/music-generation', {
        method: 'POST',
        body: JSON.stringify(parsedPrompt.data),
      });
      setSubmitMessage('La richiesta è stata inviata.');
    } catch (error) {
      setSubmitMessage(unavailableMessage(errorCode(error)));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Solco Pro</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Crea un brano
        </h1>
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">
          Descrivi l’atmosfera, il ritmo e gli strumenti che immagini. Qui troverai le tue creazioni
          originali, separate dal diario d’ascolto e dal catalogo.
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(250px,0.8fr)]">
        <form
          onSubmit={handleSubmit}
          className="space-y-5 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-7"
        >
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary">
              <AudioLines aria-hidden="true" className="size-5" />
            </span>
            <div className="space-y-1">
              <h2 className="font-display text-xl font-semibold text-card-foreground">
                La tua idea
              </h2>
              <p className="text-sm leading-6 text-muted-foreground">
                Racconta il suono che vuoi ascoltare, con parole tue.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="song-prompt" className="text-sm font-medium text-card-foreground">
              Descrizione del brano
            </label>
            <Textarea
              id="song-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value.slice(0, PROMPT_MAX_LENGTH))}
              placeholder="Per esempio: un brano strumentale lento, con piano morbido e percussioni leggere, come una passeggiata serale dopo la pioggia."
              rows={7}
              maxLength={PROMPT_MAX_LENGTH}
              aria-describedby="song-prompt-hint song-prompt-count"
              className="min-h-40 resize-y rounded-xl bg-background pr-12 text-base leading-7 sm:pr-4"
            />
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span id="song-prompt-hint">Indica genere, atmosfera, ritmo o strumenti.</span>
              <span id="song-prompt-count" aria-live="polite">
                {prompt.length}/{PROMPT_MAX_LENGTH}
              </span>
            </div>
          </div>

          <Button type="submit" size="lg" disabled={submitting} className="w-full sm:w-auto">
            <AudioLines aria-hidden="true" className="size-4" />
            {submitting ? 'Verifica accesso…' : 'Genera brano'}
          </Button>

          {submitMessage ? (
            <output
              aria-live="polite"
              className="flex items-start gap-2 text-sm leading-6 text-muted-foreground"
            >
              <CircleAlert
                aria-hidden="true"
                className="mt-1 size-4 shrink-0 text-status-warning"
              />
              <span>{submitMessage}</span>
            </output>
          ) : null}
        </form>

        <aside className="space-y-4 rounded-2xl border border-border bg-secondary/60 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <LockKeyhole aria-hidden="true" className="mt-1 size-5 shrink-0 text-primary" />
            <div className="space-y-2">
              <h2 className="font-display text-lg font-semibold text-foreground">
                Creazioni personali
              </h2>
              <p className="text-sm leading-6 text-muted-foreground">
                La libreria mostrerà soltanto brani realmente prodotti da un provider collegato al
                tuo account. Nessuna registrazione del catalogo viene presentata come generata.
              </p>
            </div>
          </div>
          <div
            aria-live="polite"
            className="rounded-xl border border-border/80 bg-card p-4 text-sm leading-6 text-card-foreground"
          >
            {checkingLibrary ? 'Verifica della libreria…' : libraryMessage}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            I controlli d’accesso del servizio avvengono sul server.
          </p>
        </aside>
      </section>

      <section aria-labelledby="created-songs-heading" className="space-y-4">
        <div className="flex items-center gap-3">
          <Music2 aria-hidden="true" className="size-5 text-primary" />
          <h2
            id="created-songs-heading"
            className="font-display text-xl font-semibold text-foreground"
          >
            I tuoi brani
          </h2>
        </div>
        <div className="rounded-2xl border border-dashed border-border bg-card/70 p-6 text-sm leading-6 text-muted-foreground sm:p-8">
          I brani ascoltabili appariranno qui dopo una generazione reale. La libreria non è ancora
          disponibile perché il provider musicale autorizzato non è stato configurato.
        </div>
      </section>
    </div>
  );
}
