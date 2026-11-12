// @polsia:user-owned — "Organizza con l'AI": l'ascoltatore incolla un testo lungo e disordinato
// (una scaletta di concerto, una classifica di fine anno, l'export di una chat, un thread di forum)
// e Claude Opus 5.5 lo legge TUTTO con la sua finestra da 1M token ed estrae un elenco pulito di
// brani (Artista - Titolo). L'elenco alimenta l'importazione dell'elenco brani esistente
// (POST /api/music/import/track-list), che crea la playlist e risolve i brani su YouTube solo quando
// si ascoltano — nessuna reimplementazione. Funzione Premium: ogni chiamata è a carico del
// proprietario di Solco. Onesto come "Cerca con l'AI": il pannello è visibile solo quando la chiave
// Anthropic funziona, e quando il server dice che non può funzionare toglie il modulo invece di
// riproporne uno che fallirebbe di nuovo.
'use client';

import { Loader2, Sparkles, Wand2 } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  AI_ORGANIZE_NAME_MAX,
  AI_ORGANIZE_TEXT_MAX,
  AI_ORGANIZE_TEXT_MIN,
  type AiOrganizeResult,
  AiOrganizeResultSchema,
  AiOrganizeStatusSchema,
} from '@/lib/contracts/ai-long-organize';
import { TrackListImportResponseSchema } from '@/lib/contracts/library';
import styles from './discover.module.css';

/** The error body the route attaches to a failed `apiFetch` (via `Error.cause`). */
function errorCause(error: unknown) {
  return error instanceof Error && typeof error.cause === 'object' && error.cause !== null
    ? (error.cause as {
        error?: unknown;
        message?: unknown;
        errors?: { text?: unknown };
        inputTokens?: unknown;
        maxInputTokens?: unknown;
      })
    : null;
}

/** Italian formatting for the token count and the approximate dollar cost the server reports. */
function formatTokens(value: number) {
  return value.toLocaleString('it-IT');
}
function formatUsd(value: number) {
  return value.toLocaleString('it-IT', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  });
}

const UNAVAILABLE_TEXT =
  'L’organizzazione con l’AI non è disponibile in questo momento. Puoi comunque incollare tu l’elenco “Artista - Titolo” qui sopra.';

/**
 * Pannello Premium "Organizza con l'AI". Due passi: (1) incolli un testo lungo e Opus 5.5 ne
 * estrae i brani; (2) rivedi/correggi l'elenco e crei la playlist riusando l'importazione
 * dell'elenco brani esistente. `onImported` ricarica la lista delle playlist intorno (come per
 * `TrackListImport`) quando la playlist è creata.
 */
export function AiOrganize({ onImported }: { onImported?: () => void }) {
  const ids = {
    text: useId(),
    lines: useId(),
    name: useId(),
  };
  const [status, setStatus] = useState<{ signedIn: boolean; premium: boolean } | null>(null);

  // Passo 1 — estrazione.
  const [text, setText] = useState('');
  const [organizing, setOrganizing] = useState(false);
  const [organizeError, setOrganizeError] = useState<string | null>(null);
  // Vero quando il server risponde "not_configured": il modulo fallirebbe soltanto, lo sostituiamo.
  const [unavailable, setUnavailable] = useState(false);
  const [result, setResult] = useState<AiOrganizeResult | null>(null);

  // Passo 2 — revisione e creazione.
  const [lines, setLines] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; imported: number } | null>(null);

  const textRef = useRef<HTMLTextAreaElement>(null);
  const unavailableRef = useRef<HTMLParagraphElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const createdRef = useRef<HTMLOutputElement>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/music/ai-organize', { schema: AiOrganizeStatusSchema })
      .then((value) => !cancelled && setStatus(value.enabled ? value : null))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, []);

  // Il pulsante che aveva il focus sparisce con il modulo: spostalo sulla spiegazione.
  useEffect(() => {
    if (unavailable) unavailableRef.current?.focus();
  }, [unavailable]);
  // Quando arriva l'elenco, porta il focus alla sezione di revisione.
  useEffect(() => {
    if (result) reviewRef.current?.focus();
  }, [result]);
  // Quando la playlist è creata, porta il focus al messaggio di esito.
  useEffect(() => {
    if (created) createdRef.current?.focus();
  }, [created]);

  // Finché il GET non risponde (o la chiave non funziona) il pannello non c'è: onesto come la ricerca AI.
  if (!status) return null;

  const organize = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (value.length < AI_ORGANIZE_TEXT_MIN || organizing) return;
    setOrganizing(true);
    setOrganizeError(null);
    setResult(null);
    setCreated(null);
    setCreateError(null);
    try {
      const response = await apiFetch('/api/music/ai-organize', {
        method: 'POST',
        body: JSON.stringify({ text: value }),
        schema: AiOrganizeResultSchema,
      });
      setResult(response);
      setLines(response.trackListText);
    } catch (reason) {
      const cause = errorCause(reason);
      if (cause?.error === 'not_configured') {
        setUnavailable(true);
        setOrganizeError(null);
        return;
      }
      // too_large / busy / failed / refused / empty portano un messaggio già pronto in italiano.
      if (typeof cause?.message === 'string') setOrganizeError(cause.message);
      else if (typeof cause?.errors?.text === 'string') setOrganizeError(cause.errors.text);
      else setOrganizeError('Non sono riuscito a leggere il testo. Riprova.');
    } finally {
      setOrganizing(false);
    }
  };

  const createPlaylist = async (event: FormEvent) => {
    event.preventDefault();
    const value = lines.trim();
    if (!value || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const response = await apiFetch('/api/music/import/track-list', {
        method: 'POST',
        body: JSON.stringify({ text: value, name: name.trim() || undefined }),
        schema: TrackListImportResponseSchema,
      });
      setCreated({ name: response.name, imported: response.imported });
      const notes = [
        response.skipped ? `${response.skipped} saltati` : '',
        response.truncated ? `${response.truncated} oltre il limite di 200` : '',
      ].filter(Boolean);
      toast.success(
        `“${response.name}” creata: ${response.imported} brani${notes.length ? ` (${notes.join(', ')})` : ''}.`,
      );
      onImported?.();
    } catch (reason) {
      // I problemi di campo restano sul modulo; il resto è un toast passeggero.
      const cause = errorCause(reason);
      if (typeof cause?.errors?.text === 'string') setCreateError(cause.errors.text);
      else
        toast.error(
          typeof cause?.message === 'string' ? cause.message : 'Creazione non riuscita. Riprova.',
        );
    } finally {
      setCreating(false);
    }
  };

  const reset = () => {
    setText('');
    setResult(null);
    setLines('');
    setName('');
    setOrganizeError(null);
    setCreateError(null);
    setCreated(null);
    // Il pulsante "Organizza un altro testo" sparisce con la sezione di revisione (result -> null):
    // senza questo il focus ricadrebbe sul body. Riportalo sulla casella del testo, sempre montata.
    textRef.current?.focus();
  };

  return (
    <details className={styles.importPanel}>
      <summary>
        <Wand2 aria-hidden="true" /> Organizza con l’AI · Claude Opus 5.5
        {status.premium ? null : <span className={styles.premiumBadge}>Premium</span>}
      </summary>

      {!status.signedIn ? (
        <p className={styles.state}>
          L’organizzazione con l’AI è inclusa in Premium.{' '}
          <Link href="/login?callbackURL=%2Flibrary">Accedi</Link> o{' '}
          <Link href="/signup?callbackURL=%2Fpiani">crea un account</Link> e provala gratis per 10
          giorni.
        </p>
      ) : !status.premium ? (
        <div className={styles.aiForm}>
          <p className={styles.state}>
            Incolla una scaletta, una classifica di fine anno o l’export di una chat: Claude Opus
            5.5 lo legge tutto (fino a ~1 milione di token) ed estrae un elenco pulito di brani con
            cui creare una playlist. È inclusa nei piani Premium.
          </p>
          <div className={styles.headerActions}>
            <Button asChild>
              <Link href="/piani">
                <Sparkles aria-hidden="true" /> Prova Premium gratis per 10 giorni
              </Link>
            </Button>
          </div>
        </div>
      ) : unavailable ? (
        <p ref={unavailableRef} tabIndex={-1} role="alert" className={styles.state}>
          {UNAVAILABLE_TEXT}
        </p>
      ) : (
        <div className={styles.aiForm}>
          <form className={styles.aiForm} onSubmit={(event) => void organize(event)}>
            <label htmlFor={ids.text} className={styles.state}>
              Incolla una lista o un testo lungo e disordinato: una scaletta di concerto, una
              classifica di fine anno, l’export di una chat, un thread di forum. Claude Opus 5.5 lo
              legge tutto (fino a ~1 milione di token: con un testo molto lungo può richiedere fino
              a un minuto) ed estrae i brani.
            </label>
            <textarea
              ref={textRef}
              id={ids.text}
              value={text}
              rows={8}
              maxLength={AI_ORGANIZE_TEXT_MAX}
              placeholder="Incolla qui una lista o un testo lungo…"
              onChange={(event) => setText(event.target.value)}
              className="w-full rounded-lg border border-input bg-background p-3 text-sm"
            />
            <p className={styles.state}>
              {text.length.toLocaleString('it-IT')} caratteri · il testo viene inviato ad Anthropic
              (Claude) per estrarre i brani. <Link href="/privacy">Privacy</Link>
            </p>
            <div className={styles.headerActions}>
              <Button
                type="submit"
                aria-busy={organizing}
                disabled={organizing || text.trim().length < AI_ORGANIZE_TEXT_MIN}
              >
                {organizing ? (
                  <Loader2 aria-hidden="true" className={styles.spin} />
                ) : (
                  <Wand2 aria-hidden="true" />
                )}
                {organizing ? 'Opus 5.5 sta leggendo…' : 'Organizza con l’AI'}
              </Button>
            </div>
            {organizing ? (
              <p className={styles.state} aria-hidden="true">
                <Loader2 aria-hidden="true" className={styles.spin} /> Opus 5.5 sta leggendo tutto
                il testo: con un testo molto lungo può richiedere fino a un minuto.
              </p>
            ) : null}
            <output className="sr-only" aria-live="polite">
              {organizing
                ? 'Claude Opus 5.5 sta leggendo tutto il testo: può richiedere fino a un minuto.'
                : ''}
            </output>
            {organizeError ? (
              <p className={styles.state} role="alert">
                {organizeError}
              </p>
            ) : null}
          </form>

          {result ? (
            <section className={styles.aiResults} aria-labelledby={`${ids.lines}-title`}>
              <h3 ref={reviewRef} id={`${ids.lines}-title`} tabIndex={-1}>
                {result.tracks.length} brani estratti
              </h3>
              {result.note ? <p className={styles.state}>{result.note}</p> : null}
              <p className={styles.state}>
                Lette ~{formatTokens(result.inputTokens)} token · costo stimato ≈{' '}
                {formatUsd(result.approxUsd)}
                {result.truncated
                  ? ` · ${result.truncated} brani oltre il limite di 200 non inclusi`
                  : ''}
                .
              </p>

              {created ? (
                <output ref={createdRef} tabIndex={-1} className={styles.state}>
                  “{created.name}” creata con {created.imported} brani. La trovi tra le tue{' '}
                  <Link href="/library?tab=playlist">playlist</Link>.{' '}
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={reset}
                  >
                    Organizza un altro testo
                  </Button>
                </output>
              ) : (
                <form className={styles.aiForm} onSubmit={(event) => void createPlaylist(event)}>
                  <label htmlFor={ids.lines} className={styles.state}>
                    Rivedi o correggi l’elenco (un brano per riga, “Artista - Titolo”) prima di
                    creare la playlist.
                  </label>
                  <textarea
                    id={ids.lines}
                    value={lines}
                    rows={8}
                    placeholder={'Artista - Titolo\nArtista - Titolo'}
                    onChange={(event) => setLines(event.target.value)}
                    className="w-full rounded-lg border border-input bg-background p-3 text-sm"
                  />
                  <label htmlFor={ids.name} className="sr-only">
                    Nome della playlist
                  </label>
                  <input
                    id={ids.name}
                    value={name}
                    maxLength={AI_ORGANIZE_NAME_MAX}
                    placeholder="Nome della playlist (facoltativo)"
                    onChange={(event) => setName(event.target.value)}
                    className="min-h-10 rounded-lg border border-input bg-background px-3 text-sm"
                  />
                  <div className={styles.headerActions}>
                    <Button type="submit" aria-busy={creating} disabled={creating || !lines.trim()}>
                      {creating ? 'Creazione…' : 'Crea playlist'}
                    </Button>
                  </div>
                  {createError ? (
                    <p className={styles.state} role="alert">
                      {createError}
                    </p>
                  ) : null}
                </form>
              )}
            </section>
          ) : null}
        </div>
      )}
    </details>
  );
}
