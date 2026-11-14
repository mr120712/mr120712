// @polsia:user-owned — «Bot Solco»: un bot sul sito. Scrivi cosa cerchi e risponde con brani
// Creative Commons, radio e podcast riproducibili nel player (con l'effetto slowed/sped up). Gli
// account free hanno 30 ricerche al mese; i Premium illimitate. Consuma BotCommandResponseSchema
// via apiFetch; ogni invio conta UN utilizzo (il server fa da fonte di verità sul limite).
'use client';

import { Bot, ListMusic, Lock, Pause, Play, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { stationToTrack } from '@/components/custom/music/live-tracks';
import {
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import {
  type BotCommandResponse,
  BotCommandResponseSchema,
  type BotQuota,
  BotQuotaSchema,
} from '@/lib/contracts/bot';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import type { UnifiedResult } from '@/lib/contracts/unified-search';
import styles from './bot-console.module.css';

const SUGGESTIONS = [
  'lofi per studiare',
  'jazz rilassante',
  'elettronica',
  'radio indie',
  'podcast tech',
];

/** Audius search track → player track (stesse scelte della ricerca unificata). */
function audiusToPlayerTrack(track: AudiusTrackSearchResult): MusicPlayerTrack {
  return {
    qualifiedId: track.qualifiedId,
    title: track.title,
    artistName: track.artistName,
    artistUrl: track.artistUrl,
    artworkUrl: track.artworkUrl,
    sourceLabel: 'Audius',
    sourceUrl: track.trackUrl,
    sourceUrlLabel: 'Apri il brano su Audius',
    durationSeconds: track.durationSeconds,
    playbackMode: 'audius',
  };
}

function formatDuration(seconds: number | null | undefined) {
  if (!seconds) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

type BotError = { code: string; text: string; used?: number; limit?: number };

function toBotError(error: unknown): BotError {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as Record<string, unknown>)
      : null;
  const code = typeof cause?.error === 'string' ? cause.error : '';
  if (code === 'quota_reached') {
    return {
      code,
      text: 'Hai esaurito le 30 ricerche gratuite di questo mese.',
      used: typeof cause?.used === 'number' ? cause.used : 30,
      limit: typeof cause?.limit === 'number' ? cause.limit : 30,
    };
  }
  if (code === 'login_required') return { code, text: 'Accedi per usare il Bot Solco.' };
  if (code === 'rate_limited') {
    return { code, text: 'Troppe ricerche ravvicinate. Riprova tra qualche secondo.' };
  }
  if (cause && typeof cause.errors === 'object') {
    return { code: 'invalid', text: 'Scrivi una ricerca da 1 a 80 caratteri.' };
  }
  return { code: 'error', text: 'Qualcosa non ha funzionato. Riprova tra poco.' };
}

export function BotConsole() {
  const player = useMusicPlayer();
  const { data: authData, isPending: authPending } = useSession();
  const user = authData?.user ?? null;

  const [quota, setQuota] = useState<BotQuota | null>(null);
  const [draft, setDraft] = useState('');
  const [response, setResponse] = useState<BotCommandResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);

  // Stato della quota al caricamento (solo se loggato): mostra quante ricerche restano.
  useEffect(() => {
    if (!user) {
      setQuota(null);
      return;
    }
    let cancelled = false;
    apiFetch('/api/bot/command', { schema: BotQuotaSchema })
      .then((value) => {
        if (!cancelled) setQuota(value);
      })
      .catch(() => {
        /* quota non disponibile: la pagina resta usabile, il limite lo impone il server */
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const results = response?.results ?? [];
  const audiusQueue = useMemo(
    () =>
      results
        .filter(
          (r): r is Extract<UnifiedResult, { kind: 'audius' }> =>
            r.kind === 'audius' && r.track.playbackEligible,
        )
        .map((r) => audiusToPlayerTrack(r.track)),
    [results],
  );
  const radioQueue = useMemo(
    () =>
      results
        .filter((r): r is Extract<UnifiedResult, { kind: 'radio' }> => r.kind === 'radio')
        .map((r) => stationToTrack(r.station)),
    [results],
  );

  const isActive = (qualifiedId: string) => player.currentTrack?.qualifiedId === qualifiedId;
  const isPlayingNow = (qualifiedId: string) =>
    isActive(qualifiedId) && (player.status === 'playing' || player.status === 'loading');

  const play = (track: MusicPlayerTrack, queue: MusicPlayerTrack[]) => {
    if (isActive(track.qualifiedId)) {
      void player.togglePlayback();
      return;
    }
    const path = trackStreamPath(track);
    if (path) void player.playTrack(track, path, queue.length ? queue : [track]);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const term = draft.trim().slice(0, 80);
    if (!term || pending) return;
    setPending(true);
    setError(null);
    setCapped(false);
    try {
      const data = await apiFetch('/api/bot/command', {
        method: 'POST',
        body: JSON.stringify({ query: term }),
        schema: BotCommandResponseSchema,
      });
      setResponse(data);
      setQuota({
        premium: data.premium,
        used: data.used,
        limit: data.limit,
        remaining: data.remaining,
      });
    } catch (err) {
      const info = toBotError(err);
      if (info.code === 'quota_reached') {
        setCapped(true);
        setQuota({ premium: false, used: info.used ?? 30, limit: info.limit ?? 30, remaining: 0 });
      }
      setError(info.text);
    } finally {
      setPending(false);
    }
  };

  const quotaLine = (() => {
    if (!user) return '30 ricerche gratis al mese · Premium illimitato';
    if (!quota) return 'Bot pronto.';
    if (quota.premium) return 'Premium: ricerche illimitate ✨';
    return `${quota.remaining ?? 0} di ${quota.limit ?? 30} ricerche gratuite rimaste questo mese`;
  })();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.logo} aria-hidden="true">
          <Bot />
        </span>
        <div>
          <h1 className={styles.title}>Bot Solco</h1>
          <p className={styles.lead}>
            Dimmi che musica cerchi: ti trovo brani Creative Commons, radio e podcast, e li faccio
            partire nel player Solco (anche in <strong>slowed / sped up</strong>).
          </p>
          <p className={styles.quota} data-capped={capped || undefined}>
            {quotaLine}
          </p>
        </div>
      </header>

      <form className={styles.commandRow} onSubmit={submit}>
        <label className="sr-only" htmlFor="bot-command">
          Chiedi al Bot Solco
        </label>
        <input
          id="bot-command"
          type="search"
          value={draft}
          maxLength={80}
          placeholder="Es. «lofi per studiare» o «jazz rilassante»"
          autoComplete="off"
          disabled={!user || pending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className={styles.send} disabled={!user || pending || !draft.trim()}>
          <Sparkles aria-hidden="true" />
          <span>{pending ? 'Cerco…' : 'Chiedi'}</span>
        </button>
      </form>

      <div className={styles.suggestions}>
        {SUGGESTIONS.map((text) => (
          <button
            key={text}
            type="button"
            className={styles.chip}
            disabled={!user || pending}
            onClick={() => setDraft(text)}
          >
            {text}
          </button>
        ))}
      </div>

      {!user ? (
        <div className={styles.gate}>
          <Lock aria-hidden="true" />
          <p>
            {authPending ? 'Un momento…' : 'Accedi per usare il bot: 30 ricerche gratis ogni mese.'}
          </p>
          <div className={styles.gateActions}>
            <Link href="/login" className={styles.primaryBtn}>
              Accedi
            </Link>
            <Link href="/signup" className={styles.secondaryBtn}>
              Registrati
            </Link>
          </div>
        </div>
      ) : null}

      {error ? (
        <output className={styles.error} aria-live="polite">
          {error}
        </output>
      ) : null}

      {capped ? (
        <div className={styles.upsell}>
          <Sparkles aria-hidden="true" />
          <p>
            Hai usato tutte le ricerche gratuite del mese. Con <strong>Solco Premium</strong> il bot
            è illimitato (e niente limiti di ascolto).
          </p>
          <Link href="/piani" className={styles.primaryBtn}>
            Passa a Premium
          </Link>
        </div>
      ) : null}

      {response ? (
        <section className={styles.results} aria-label={`Risultati per ${response.query}`}>
          <h2 className={styles.resultsTitle}>
            {results.length > 0
              ? `Ecco cosa ho trovato per «${response.query}»`
              : `Nessun risultato per «${response.query}». Prova parole diverse.`}
          </h2>
          <ol className={styles.list}>
            {results.map((result) => (
              <BotRow
                key={result.key}
                result={result}
                isPlayingNow={isPlayingNow}
                onPlayAudius={(track) =>
                  track.playbackEligible && play(audiusToPlayerTrack(track), audiusQueue)
                }
                onPlayStation={(station) => play(stationToTrack(station), radioQueue)}
              />
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function BotRow({
  result,
  isPlayingNow,
  onPlayAudius,
  onPlayStation,
}: {
  result: UnifiedResult;
  isPlayingNow: (qualifiedId: string) => boolean;
  onPlayAudius: (track: AudiusTrackSearchResult) => void;
  onPlayStation: (station: Extract<UnifiedResult, { kind: 'radio' }>['station']) => void;
}) {
  if (result.kind === 'audius') {
    const { track } = result;
    const playing = isPlayingNow(track.qualifiedId);
    return (
      <li className={styles.row}>
        <div className={styles.art}>
          <FallbackArt src={track.artworkUrl} label={track.title} size={96} />
        </div>
        <div className={styles.copy}>
          <span className={styles.badge} data-source="audius">
            Audius
          </span>
          <strong className={styles.rowTitle} title={track.title}>
            {track.title}
          </strong>
          <span className={styles.sub}>
            {[track.artistName, formatDuration(track.durationSeconds)].filter(Boolean).join(' · ')}
          </span>
          <AudiusLicenseNotice track={track} showTrackLink />
        </div>
        <div className={styles.actions}>
          {track.playbackEligible ? (
            <button
              type="button"
              className={styles.playBtn}
              onClick={() => onPlayAudius(track)}
              aria-label={playing ? `Metti in pausa ${track.title}` : `Riproduci ${track.title}`}
            >
              {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </button>
          ) : null}
        </div>
      </li>
    );
  }

  if (result.kind === 'radio') {
    const { station } = result;
    const playing = isPlayingNow(`radio:${station.id}`);
    const meta = [station.country, station.tags[0]].filter(Boolean).join(' · ');
    return (
      <li className={styles.row}>
        <div className={styles.art}>
          <FallbackArt src={station.artworkUrl} label={station.name} size={96} />
        </div>
        <div className={styles.copy}>
          <span className={styles.badge} data-source="radio">
            Radio
          </span>
          <strong className={styles.rowTitle} title={station.name}>
            {station.name}
          </strong>
          <span className={styles.sub}>{meta || 'In diretta'}</span>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.playBtn}
            onClick={() => onPlayStation(station)}
            aria-label={
              playing ? `Metti in pausa ${station.name}` : `Ascolta ${station.name} in diretta`
            }
          >
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </button>
        </div>
      </li>
    );
  }

  if (result.kind === 'podcast') {
    const { podcast } = result;
    const href = `/podcasts/${encodeURIComponent(podcast.id)}`;
    return (
      <li className={styles.row}>
        <div className={styles.art}>
          <FallbackArt src={podcast.artworkUrl} label={podcast.title} size={96} />
        </div>
        <div className={styles.copy}>
          <span className={styles.badge} data-source="podcast">
            Podcast
          </span>
          <Link href={href} className={styles.rowTitle} title={podcast.title}>
            {podcast.title}
          </Link>
          <span className={styles.sub}>{podcast.author ?? podcast.genre ?? 'Podcast'}</span>
        </div>
        <div className={styles.actions}>
          <Link href={href} className={styles.openBtn} aria-label={`Apri ${podcast.title}`}>
            <ListMusic aria-hidden="true" />
          </Link>
        </div>
      </li>
    );
  }

  return null;
}
