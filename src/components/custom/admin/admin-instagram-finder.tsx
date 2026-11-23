// @polsia:user-owned
'use client';

import { Download, ExternalLink, Search, Sparkles, TriangleAlert } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import {
  type InstagramCreator,
  type InstagramFinderInput,
  type InstagramFinderResponse,
  InstagramFinderResponseSchema,
} from '@/lib/contracts/instagram-finder';

const errorMessages: Record<string, string> = {
  not_configured:
    'Instagram non è collegato: imposta INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_BUSINESS_ACCOUNT_ID su Vercel.',
  auth: 'Meta rifiuta il token: è scaduto o revocato. Generane uno nuovo (token di lunga durata).',
  permission:
    'Permesso mancante sull’app Meta per leggere i profili: servono instagram_basic, pages_show_list e pages_read_engagement sul token.',
  rate_limited: 'Limite di richieste di Meta raggiunto. Riprova fra un’ora.',
  hashtag_limit:
    'Limite di Meta: al massimo 30 hashtag diversi ogni 7 giorni. Riusa hashtag già cercati.',
  timeout: 'Meta non ha risposto in tempo. Riprova.',
  failed: 'Errore della Graph API di Meta.',
  rate_limited_local: 'Hai fatto molte ricerche di recente. Attendi un momento.',
  invalid_request: 'Controlla i campi: username validi, minimo follower ≤ massimo.',
  unauthorized: 'Sessione scaduta: accedi di nuovo.',
  forbidden: 'Solo gli amministratori verificati possono usare questo strumento.',
};

function errorMessage(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause && typeof cause === 'object' && 'error' in cause ? String(cause.error) : undefined;
  const detail =
    cause && typeof cause === 'object' && 'detail' in cause && typeof cause.detail === 'string'
      ? ` (${cause.detail})`
      : '';
  const key = code === 'rate_limited' && !detail ? 'rate_limited_local' : code;
  return key && errorMessages[key]
    ? `${errorMessages[key]}${detail}`
    : 'Ricerca non riuscita. Riprova.';
}

function list(value: string) {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalNumber(value: string) {
  const number = Number(value.replace(/[._\s]/g, ''));
  return value.trim() && Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

const compact = new Intl.NumberFormat('it-IT', { notation: 'compact', maximumFractionDigits: 1 });

function csvCell(value: string | number | null) {
  const text = value === null ? '' : String(value);
  // Niente formule nei fogli di calcolo (=, +, -, @ all'inizio).
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function downloadCsv(creators: InstagramCreator[]) {
  const header = [
    'username',
    'profilo',
    'nome',
    'follower',
    'engagement_%',
    'like_medi',
    'commenti_medi',
    'ultimo_post',
    'punteggio',
    'motivo',
    'sito',
    'trovato_via',
  ];
  const rows = creators.map((c) =>
    [
      c.username,
      `https://www.instagram.com/${c.username}/`,
      c.name,
      c.followers,
      (c.engagementRate * 100).toFixed(2),
      c.avgLikes,
      c.avgComments,
      c.lastPostAt,
      c.score,
      c.reason,
      c.website,
      c.foundVia.join(' '),
    ]
      .map(csvCell)
      .join(','),
  );
  const blob = new Blob([[header.join(','), ...rows].join('\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'creator-instagram.csv';
  link.click();
  URL.revokeObjectURL(url);
}

export function AdminInstagramFinder() {
  const ids = { brief: useId(), tags: useId(), users: useId(), min: useId(), max: useId() };
  const [brief, setBrief] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [usernames, setUsernames] = useState('');
  const [minFollowers, setMinFollowers] = useState('');
  const [maxFollowers, setMaxFollowers] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<InstagramFinderResponse | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || brief.trim().length < 3) return;
    setPending(true);
    setProblem(null);
    const payload: InstagramFinderInput = {
      brief: brief.trim(),
      hashtags: list(hashtags).slice(0, 5),
      usernames: list(usernames).slice(0, 20),
      minFollowers: optionalNumber(minFollowers),
      maxFollowers: optionalNumber(maxFollowers),
    };
    try {
      setResult(
        await apiFetch('/api/admin/instagram-finder', {
          method: 'POST',
          body: JSON.stringify(payload),
          schema: InstagramFinderResponseSchema,
        }),
      );
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-5">
      <form
        onSubmit={submit}
        className="grid gap-4 rounded-xl border border-border bg-card p-5 shadow-sm"
        aria-busy={pending}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={ids.brief}>Chi cerchi?</Label>
          <Textarea
            id={ids.brief}
            value={brief}
            onChange={(event) => setBrief(event.currentTarget.value)}
            maxLength={500}
            rows={3}
            required
            placeholder="Es. producer lo-fi italiani che pubblicano beat, 5k–100k follower, per una collaborazione"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={ids.tags}>Hashtag (facoltativi, max 5)</Label>
            <Input
              id={ids.tags}
              value={hashtags}
              onChange={(event) => setHashtags(event.currentTarget.value)}
              placeholder="lofibeats, producerlife"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.users}>Username da verificare (facoltativi)</Label>
            <Input
              id={ids.users}
              value={usernames}
              onChange={(event) => setUsernames(event.currentTarget.value)}
              placeholder="@account1, @account2"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.min}>Follower minimi</Label>
            <Input
              id={ids.min}
              inputMode="numeric"
              value={minFollowers}
              onChange={(event) => setMinFollowers(event.currentTarget.value)}
              placeholder="5000"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.max}>Follower massimi</Label>
            <Input
              id={ids.max}
              inputMode="numeric"
              value={maxFollowers}
              onChange={(event) => setMaxFollowers(event.currentTarget.value)}
              placeholder="100000"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending || brief.trim().length < 3}>
            <Search aria-hidden="true" className="size-4" />
            {pending ? 'Ricerca in corso… (fino a un minuto)' : 'Trova creator'}
          </Button>
          <p className="text-xs leading-5 text-muted-foreground">
            Solo account Business/Creator pubblici, tramite l’API ufficiale di Meta.
          </p>
        </div>
        {problem ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm leading-6 text-destructive"
          >
            {problem}
          </p>
        ) : null}
      </form>

      {result ? (
        <section className="grid gap-4" aria-live="polite">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1">
              <h2 className="flex items-center gap-2 font-semibold">
                <Sparkles aria-hidden="true" className="size-4 text-primary" />
                {result.creators.length} creator trovati
              </h2>
              <p className="text-sm text-muted-foreground">
                {result.summary} · hashtag:{' '}
                {result.hashtags.map((tag) => `#${tag}`).join(' ') || 'nessuno'} · {result.checked}{' '}
                profili controllati, {result.skipped} non Business/Creator
                {result.aiRanked ? ' · ordinati dall’AI' : ''}
              </p>
            </div>
            {result.creators.length > 0 ? (
              <Button type="button" variant="outline" onClick={() => downloadCsv(result.creators)}>
                <Download aria-hidden="true" className="size-4" /> Esporta CSV
              </Button>
            ) : null}
          </header>

          {result.warnings.length > 0 ? (
            <ul className="grid gap-1 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
              {result.warnings.map((warning) => (
                <li key={warning} className="flex gap-2">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}

          <ol className="grid gap-3">
            {result.creators.map((creator) => (
              <li
                key={creator.username}
                className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]"
              >
                {creator.profilePictureUrl ? (
                  // biome-ignore lint/performance/noImgElement: avatar dal CDN di Instagram, URL temporaneo.
                  <img
                    src={creator.profilePictureUrl}
                    alt=""
                    width={56}
                    height={56}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="size-14 rounded-full object-cover"
                  />
                ) : (
                  <span className="size-14 rounded-full bg-muted" aria-hidden="true" />
                )}
                <div className="grid min-w-0 gap-1">
                  <a
                    href={`https://www.instagram.com/${creator.username}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-semibold hover:underline"
                  >
                    @{creator.username}
                    <ExternalLink aria-hidden="true" className="size-3.5" />
                  </a>
                  {creator.name ? <p className="text-sm">{creator.name}</p> : null}
                  {creator.biography ? (
                    <p className="line-clamp-3 whitespace-pre-line text-sm text-muted-foreground">
                      {creator.biography}
                    </p>
                  ) : null}
                  <p className="text-sm">{creator.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    {compact.format(creator.followers)} follower ·{' '}
                    {(creator.engagementRate * 100).toFixed(1)}% engagement ·{' '}
                    {compact.format(creator.avgLikes)} like medi · {creator.mediaCount} post
                    {creator.lastPostAt
                      ? ` · ultimo post ${new Date(creator.lastPostAt).toLocaleDateString('it-IT')}`
                      : ''}
                    {' · '}via {creator.foundVia.join(', ')}
                    {creator.website ? (
                      <>
                        {' · '}
                        <a
                          href={creator.website}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="underline"
                        >
                          sito
                        </a>
                      </>
                    ) : null}
                  </p>
                </div>
                <p
                  className="self-start rounded-full bg-primary/10 px-3 py-1 text-sm font-semibold text-primary"
                  title="Punteggio di adattamento (0–100)"
                >
                  {creator.score}
                </p>
              </li>
            ))}
          </ol>

          {result.posts.length > 0 ? (
            <details className="rounded-xl border border-border bg-card p-4">
              <summary className="cursor-pointer text-sm font-semibold">
                Post più forti degli hashtag ({result.posts.length})
              </summary>
              <ul className="mt-3 grid gap-2 text-sm">
                {result.posts.map((post) => (
                  <li key={post.permalink} className="grid gap-0.5">
                    <a
                      href={post.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:underline"
                    >
                      #{post.hashtag} · {compact.format(post.likes)} like ·{' '}
                      {compact.format(post.comments)} commenti
                    </a>
                    <span className="line-clamp-2 text-muted-foreground">{post.caption}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
