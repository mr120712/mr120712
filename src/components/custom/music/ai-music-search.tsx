// @polsia:user-owned — "Cerca con l'AI": l'ascoltatore descrive cosa vuole sentire, Claude
// Opus 5.5 prepara le ricerche e Solco le esegue sulle sue fonti (YouTube, Audius, Jamendo,
// radio, podcast, generi). Visibile solo quando ANTHROPIC_API_KEY è configurata.
'use client';

import { Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { AudiusSection } from '@/components/custom/music/audius-section';
import { JamendoSection } from '@/components/custom/music/jamendo-section';
import { StationTile } from '@/components/custom/music/radio-station-tile';
import { YouTubeVideoList } from '@/components/custom/music/youtube-video-list';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import {
  AI_SEARCH_PROMPT_MAX,
  type AiSearchPlan,
  AiSearchResponseSchema,
  AiSearchStatusSchema,
} from '@/lib/contracts/ai-music-search';
import {
  type PodcastListResponse,
  PodcastListResponseSchema,
  type RadioListResponse,
  RadioListResponseSchema,
} from '@/lib/contracts/library';
import { type MusicSearchResponse, MusicSearchResponseSchema } from '@/lib/contracts/music';
import { genreCatalog } from '@/lib/music/genre-catalog';
import styles from './discover.module.css';

const EXAMPLES = [
  'Musica per studiare di notte, tipo lo-fi giapponese',
  'Canzoni italiane anni 80 da cantare in macchina',
  'Elettronica scura e ipnotica come i Massive Attack',
  'Jazz rilassato per una cena tra amici',
];

function errorMessage(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown; errors?: { prompt?: unknown } })
      : null;
  if (typeof cause?.errors?.prompt === 'string') return cause.errors.prompt;
  if (typeof cause?.message === 'string') return cause.message;
  return 'La ricerca con l’AI non è riuscita. Riprova.';
}

function YouTubeResults({ query }: { query: string }) {
  const [response, setResponse] = useState<MusicSearchResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ source: 'youtube', q: query, youtubeConsent: 'accepted' });
    apiFetch(`/api/music/search?${params.toString()}`, { schema: MusicSearchResponseSchema })
      .then((value) => !cancelled && setResponse(value))
      .catch(() => !cancelled && setResponse(null));
    return () => {
      cancelled = true;
    };
  }, [query]);
  if (!response || response.videos.length === 0) return null;
  return (
    <section className={styles.section} aria-label={`Video: ${query}`}>
      <header className={styles.sectionHeader}>
        <h3>Video · {query}</h3>
      </header>
      <YouTubeVideoList videos={response.videos} />
    </section>
  );
}

function RadioResults({ tags }: { tags: string[] }) {
  const [radio, setRadio] = useState<RadioListResponse | null>(null);
  const tag = tags[0];
  useEffect(() => {
    if (!tag) return;
    let cancelled = false;
    apiFetch(`/api/music/radio?tag=${encodeURIComponent(tag)}&limit=12`, {
      schema: RadioListResponseSchema,
    })
      .then((value) => !cancelled && setRadio(value))
      .catch(() => !cancelled && setRadio(null));
    return () => {
      cancelled = true;
    };
  }, [tag]);
  if (!radio || radio.stations.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Radio consigliate">
      <header className={styles.sectionHeader}>
        <h3>Radio · {tags.join(', ')}</h3>
      </header>
      <div className={styles.rail}>
        {radio.stations.map((station) => (
          <StationTile key={station.id} station={station} queue={radio.stations} />
        ))}
      </div>
    </section>
  );
}

function PodcastResults({ query }: { query: string }) {
  const [list, setList] = useState<PodcastListResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/music/podcasts?q=${encodeURIComponent(query)}`, {
      schema: PodcastListResponseSchema,
    })
      .then((value) => !cancelled && setList(value))
      .catch(() => !cancelled && setList(null));
    return () => {
      cancelled = true;
    };
  }, [query]);
  if (!list || list.podcasts.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Podcast consigliati">
      <header className={styles.sectionHeader}>
        <h3>Podcast · {query}</h3>
      </header>
      <ul className={styles.moodGrid}>
        {list.podcasts.slice(0, 8).map((podcast) => (
          <li key={podcast.id}>
            <Link href={`/podcasts/${podcast.id}`}>{podcast.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlanResults({ plan }: { plan: AiSearchPlan }) {
  const genres = plan.genres
    .map((slug) => genreCatalog.find((genre) => genre.slug === slug))
    .filter((genre) => genre !== undefined);
  return (
    <div className={styles.aiResults}>
      <p className={styles.aiIntro}>{plan.intro}</p>
      {genres.length ? (
        <nav className={styles.moodGrid} aria-label="Generi consigliati">
          {genres.map((genre) => (
            <Link key={genre.slug} href={`/generi/${genre.slug}`}>
              {genre.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {plan.youtubeQueries.map((query) => (
        <YouTubeResults key={`yt-${query}`} query={query} />
      ))}
      {plan.audioQueries.map((query) => (
        <div key={`audio-${query}`}>
          <AudiusSection query={query} contained />
          <JamendoSection query={query} contained />
        </div>
      ))}
      {plan.radioTags.length ? <RadioResults tags={plan.radioTags} /> : null}
      {plan.podcastQuery ? <PodcastResults query={plan.podcastQuery} /> : null}
    </div>
  );
}

export function AiMusicSearch({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const { data: session, isPending } = useSession();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(initiallyOpen);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<AiSearchPlan | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/music/ai-search', { schema: AiSearchStatusSchema })
      .then((value) => !cancelled && setEnabled(value.enabled))
      .catch(() => !cancelled && setEnabled(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!enabled) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (text.length < 3 || loading) return;
    setLoading(true);
    setError(null);
    setPlan(null);
    try {
      const response = await apiFetch('/api/music/ai-search', {
        method: 'POST',
        body: JSON.stringify({ prompt: text }),
        schema: AiSearchResponseSchema,
      });
      setPlan(response.plan);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <div className={styles.headerActions}>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          <Sparkles aria-hidden="true" /> Cerca con l’AI · Claude Opus 5.5
        </Button>
      </div>
    );
  }

  return (
    <section className={styles.aiPanel} aria-labelledby="ai-search-title">
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>CLAUDE OPUS 5.5</p>
          <h2 id="ai-search-title">Cerca con l’AI</h2>
        </div>
      </header>
      {!isPending && !session?.user ? (
        <p className={styles.state}>
          <Link href="/login?callbackURL=%2Fsearch%3Fai%3D1">Accedi</Link> o{' '}
          <Link href="/signup?callbackURL=%2Fsearch%3Fai%3D1">registrati gratis</Link> per
          descrivere a parole la musica che vuoi ascoltare.
        </p>
      ) : (
        <form onSubmit={submit} className={styles.aiForm}>
          <label htmlFor="ai-search-prompt" className={styles.state}>
            Descrivi cosa vuoi ascoltare: un’atmosfera, un momento, artisti simili, un’epoca.
          </label>
          <textarea
            id="ai-search-prompt"
            value={prompt}
            maxLength={AI_SEARCH_PROMPT_MAX}
            rows={3}
            placeholder={EXAMPLES[0]}
            onChange={(event) => setPrompt(event.target.value)}
            className="min-h-20 w-full rounded-lg border border-input bg-background p-3 text-sm"
          />
          <div className={styles.moodGrid}>
            {EXAMPLES.map((example) => (
              <button key={example} type="button" onClick={() => setPrompt(example)}>
                {example}
              </button>
            ))}
          </div>
          <div className={styles.headerActions}>
            <Button type="submit" disabled={loading || prompt.trim().length < 3}>
              {loading ? (
                <Loader2 aria-hidden="true" className={styles.spin} />
              ) : (
                <Sparkles aria-hidden="true" />
              )}
              {loading ? 'Opus 5.5 sta cercando…' : 'Cerca con l’AI'}
            </Button>
          </div>
          <p className={styles.state}>
            La descrizione viene inviata ad Anthropic (Claude) per preparare la ricerca e poi a
            YouTube e alle altre fonti. <Link href="/privacy">Privacy</Link>
          </p>
          {error ? (
            <p className={styles.state} role="alert">
              {error}
            </p>
          ) : null}
        </form>
      )}
      {plan ? <PlanResults plan={plan} /> : null}
    </section>
  );
}
