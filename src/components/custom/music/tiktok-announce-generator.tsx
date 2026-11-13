// @polsia:user-owned — generatore di annunci TikTok con Claude 5.5 per l'amministratore.
// Scrive gancio, didascalia, hashtag e copione; l'admin li rivede, li copia e gira il video su
// TikTok (TikTok non si pubblica dal server). "Usa come didascalia" riempie il campo del form sopra.
'use client';

import { Check, Copy, Sparkles, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  TIKTOK_ANGLES,
  TIKTOK_ANNOUNCE_TOPIC_MAX,
  type TikTokAnnouncement,
  TikTokAnnounceResultSchema,
  TikTokAnnounceStatusSchema,
} from '@/lib/contracts/tiktok-announce';
import styles from './discover.module.css';

const ENDPOINT = '/api/admin/tiktok/announce';

function announceError(error: unknown): string {
  if (error instanceof ZodError) return 'La risposta del server non è nel formato atteso.';
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete e riprova.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown; errors?: Record<string, unknown> })
      : null;
  if (typeof cause?.message === 'string' && cause.message.trim()) return cause.message.trim();
  const first = cause?.errors
    ? Object.values(cause.errors).find((v) => typeof v === 'string')
    : null;
  return typeof first === 'string' ? first : 'Generazione non riuscita. Riprova.';
}

async function copy(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      className="h-8 gap-1.5 px-2 text-xs"
      onClick={() => {
        void copy(text).then((ok) => {
          if (ok) {
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
            toast.success('Copiato.');
          } else {
            toast.error('Copia non riuscita: seleziona il testo a mano.');
          }
        });
      }}
    >
      {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {label}
    </Button>
  );
}

export function TikTokAnnounceGenerator({
  genreSlug,
  onUseCaption,
}: {
  genreSlug: string;
  onUseCaption: (caption: string) => void;
}) {
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [topic, setTopic] = useState('');
  const [angle, setAngle] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TikTokAnnouncement | null>(null);
  const [model, setModel] = useState('');

  useEffect(() => {
    let active = true;
    apiFetch(ENDPOINT, { schema: TikTokAnnounceStatusSchema })
      .then((data) => {
        if (active) setAiConfigured(data.aiConfigured);
      })
      .catch(() => {
        // Non blocca il pannello: se non riesco a leggere lo stato, lascio provare (la POST dirà).
        if (active) setAiConfigured(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const generate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const data = await apiFetch(ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({
          topic: topic.trim() || undefined,
          angle: angle || undefined,
          genreSlug: genreSlug || undefined,
        }),
        schema: TikTokAnnounceResultSchema,
      });
      setResult(data.announcement);
      setModel(data.model);
      setAiConfigured(true);
      toast.success('Annuncio generato.');
    } catch (error) {
      toast.error(announceError(error));
    } finally {
      setBusy(false);
    }
  }, [busy, topic, angle, genreSlug]);

  const fullText = result
    ? [
        `Gancio: ${result.hook}`,
        '',
        result.caption,
        '',
        result.hashtags.join(' '),
        '',
        `Copione (${result.script.durationSeconds}s):`,
        ...result.script.beats.map(
          (beat) =>
            `• ${beat.at} — ${beat.onScreen} | voce: ${beat.voiceover} | video: ${beat.visual}`,
        ),
        `CTA: ${result.script.cta}`,
        '',
        `Audio: ${result.soundIdea}`,
        `Alt text: ${result.altText}`,
      ].join('\n')
    : '';

  return (
    <section className={styles.aiPanel} aria-label="Genera un annuncio con l’IA">
      <div className="grid gap-1">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Sparkles aria-hidden="true" className="size-4 text-primary" />
          Scrivi l’annuncio con l’IA (Claude 5.5)
        </p>
        <p className={styles.state}>
          L’IA scrive gancio, didascalia, hashtag e copione per un video TikTok su Solco. Rivedi il
          testo, copialo e giralo tu: TikTok non si pubblica da qui.
        </p>
        {aiConfigured === false ? (
          <p className={styles.state} role="alert">
            Per usarlo imposta <code>ANTHROPIC_API_KEY</code> su Vercel e ridistribuisci.
          </p>
        ) : null}
      </div>

      <div className={styles.aiForm}>
        <label className={styles.state} htmlFor="tiktok-ai-angle">
          Taglio dell’annuncio
        </label>
        <select
          id="tiktok-ai-angle"
          value={angle}
          onChange={(event) => setAngle(event.target.value)}
          className="min-h-10 rounded-lg border border-input bg-background px-3 text-sm"
        >
          <option value="">Libero (scelto dall’IA)</option>
          {TIKTOK_ANGLES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <label className={styles.state} htmlFor="tiktok-ai-topic">
          Argomento specifico (facoltativo)
        </label>
        <textarea
          id="tiktok-ai-topic"
          value={topic}
          maxLength={TIKTOK_ANNOUNCE_TOPIC_MAX}
          rows={3}
          placeholder="Es. la radio dal vivo gratis, oppure il lancio delle playlist condivise"
          onChange={(event) => setTopic(event.target.value)}
          className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
        />
        <div className={styles.headerActions}>
          <Button
            type="button"
            onClick={() => void generate()}
            aria-disabled={busy || aiConfigured === false || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            <Wand2 aria-hidden="true" />
            {busy ? 'Scrittura…' : result ? 'Rigenera' : 'Genera annuncio'}
          </Button>
        </div>
      </div>

      {result ? (
        <div className={styles.aiResults} aria-live="polite">
          <article className="grid gap-3 rounded-xl border border-border bg-card p-4">
            <div className="grid gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Gancio
              </span>
              <p className="font-medium text-card-foreground">{result.hook}</p>
            </div>

            <div className="grid gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Didascalia
              </span>
              <p className="whitespace-pre-wrap text-sm text-foreground">{result.caption}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="h-8 gap-1.5 px-2 text-xs"
                  onClick={() => {
                    onUseCaption(result.caption);
                    toast.success('Didascalia inserita nel form qui sotto.');
                  }}
                >
                  <Check aria-hidden="true" />
                  Usa come didascalia
                </Button>
                <CopyButton label="Copia didascalia" text={result.caption} />
              </div>
            </div>

            <div className="grid gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Hashtag
              </span>
              <p className="text-sm text-primary">{result.hashtags.join(' ')}</p>
              {result.hashtags.length ? (
                <div>
                  <CopyButton label="Copia hashtag" text={result.hashtags.join(' ')} />
                </div>
              ) : null}
            </div>

            <div className="grid gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Copione ({result.script.durationSeconds}s)
              </span>
              <ol className="grid gap-2">
                {result.script.beats.map((beat, index) => (
                  <li
                    key={`${beat.at}-${index}`}
                    className="grid gap-0.5 rounded-lg border border-border/70 bg-background p-2 text-sm"
                  >
                    <span className="font-semibold text-foreground">{beat.at}</span>
                    {beat.onScreen ? (
                      <span className="text-foreground">Testo a schermo: {beat.onScreen}</span>
                    ) : null}
                    {beat.voiceover ? (
                      <span className="text-muted-foreground">Voce: {beat.voiceover}</span>
                    ) : null}
                    {beat.visual ? (
                      <span className="text-muted-foreground">Video: {beat.visual}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
              <p className="text-sm text-foreground">
                <span className="font-semibold">CTA:</span> {result.script.cta}
              </p>
            </div>

            <div className="grid gap-1 text-sm">
              <p className="text-muted-foreground">
                <span className="font-semibold text-foreground">Idea audio:</span>{' '}
                {result.soundIdea}
              </p>
              <p className="text-muted-foreground">
                <span className="font-semibold text-foreground">Alt text:</span> {result.altText}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <CopyButton label="Copia tutto" text={fullText} />
              {model ? (
                <span className="text-xs text-muted-foreground">Scritto con {model}</span>
              ) : null}
            </div>
          </article>
        </div>
      ) : null}
    </section>
  );
}
