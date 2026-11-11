// @polsia:user-owned — "Cerca con l'AI": l'ascoltatore descrive cosa vuole sentire, Claude
// Opus 5.5 prepara le ricerche e Solco le esegue sulle sue fonti (YouTube, Audius, Jamendo,
// radio, podcast, generi). Visibile solo quando ANTHROPIC_API_KEY è configurata.
'use client';

import { Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { AudiusSection } from '@/components/custom/music/audius-section';
import { JamendoSection } from '@/components/custom/music/jamendo-section';
import { useLibrary } from '@/components/custom/music/library-context';
import { StationTile } from '@/components/custom/music/radio-station-tile';
import { YouTubeVideoList } from '@/components/custom/music/youtube-video-list';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  AI_SEARCH_EXAMPLES,
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

const EXAMPLES = AI_SEARCH_EXAMPLES;

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
  const library = useLibrary();
  const [stations, setStations] = useState<RadioListResponse['stations'] | null>(null);
  const key = tags.join('|');
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    // One request per proposed tag (at most 3), merged without duplicates.
    Promise.all(
      key.split('|').map((tag) =>
        apiFetch(`/api/music/radio?tag=${encodeURIComponent(tag)}&limit=8`, {
          schema: RadioListResponseSchema,
        }).catch(() => null),
      ),
    ).then((lists) => {
      if (cancelled) return;
      const seen = new Set<string>();
      const merged = lists
        .flatMap((list) => list?.stations ?? [])
        .filter((station) => !seen.has(station.id) && Boolean(seen.add(station.id)));
      setStations(merged.slice(0, 16));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  const visible = (stations ?? []).filter((station) => !library.isHidden('station', station.id));
  if (visible.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Radio consigliate">
      <header className={styles.sectionHeader}>
        <h3>Radio · {tags.join(', ')}</h3>
      </header>
      <div className={styles.rail}>
        {visible.map((station) => (
          <StationTile key={station.id} station={station} queue={visible} />
        ))}
      </div>
    </section>
  );
}

function PodcastResults({ query }: { query: string }) {
  const library = useLibrary();
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
  const podcasts = (list?.podcasts ?? []).filter(
    (podcast) => !library.isHidden('podcast', podcast.id),
  );
  if (podcasts.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Podcast consigliati">
      <header className={styles.sectionHeader}>
        <h3>Podcast · {query}</h3>
      </header>
      <ul className={styles.moodGrid}>
        {podcasts.slice(0, 8).map((podcast) => (
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
          <AudiusSection query={query} anchor={false} />
          <JamendoSection query={query} anchor={false} />
        </div>
      ))}
      {plan.radioTags.length ? <RadioResults tags={plan.radioTags} /> : null}
      {plan.podcastQuery ? <PodcastResults query={plan.podcastQuery} /> : null}
    </div>
  );
}

export function AiMusicSearch({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [status, setStatus] = useState<{ signedIn: boolean; premium: boolean } | null>(null);
  const [open, setOpen] = useState(initiallyOpen);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<AiSearchPlan | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/music/ai-search', { schema: AiSearchStatusSchema })
      .then((value) => !cancelled && setStatus(value.enabled ? value : null))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

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
          {status.premium ? null : <span className={styles.premiumBadge}>Premium</span>}
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
      {!status.signedIn ? (
        <p className={styles.state}>
          La ricerca con l’AI è inclusa in Premium.{' '}
          <Link href="/login?callbackURL=%2Fsearch%3Fai%3D1">Accedi</Link> o{' '}
          <Link href="/signup?callbackURL=%2Fpiani">crea un account</Link> e provala gratis per 10
          giorni.
        </p>
      ) : !status.premium ? (
        <div className={styles.aiForm}>
          <p className={styles.state}>
            Descrivi a parole la musica che vuoi (“jazz rilassato per una cena tra amici”) e Claude
            Opus 5.5 la cerca per te su YouTube, Audius, radio e podcast. È inclusa nei piani
            Premium.
          </p>
          <div className={styles.headerActions}>
            <Button asChild>
              <Link href="/piani">
                <Sparkles aria-hidden="true" /> Prova Premium gratis per 10 giorni
              </Link>
            </Button>
          </div>
        </div>
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
