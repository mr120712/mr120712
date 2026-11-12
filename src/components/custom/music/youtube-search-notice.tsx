// @polsia:user-owned — cosa dire quando la ricerca YouTube non può rispondere in tempo reale:
// risultati salvati (con la data in cui YouTube li ha inviati) oppure nessun risultato, sempre
// con il collegamento alla ricerca sul sito di YouTube (un link, nessuna chiamata all'API) e,
// quando le ricerche sono finite, con i link a classifiche e generi. Distingue le ricerche
// personali finite (utente con accesso), quelle della connessione (senza accesso: lo stesso
// indirizzo IP può essere condiviso da molte persone) e quelle finite per tutti; l'ora di ripresa
// è calcolata (mezzanotte del Pacifico: 9:00 in Italia, 8:00 nelle settimane del cambio d'ora).
'use client';

import { ExternalLink, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type {
  YouTubeMusicSearchResponse,
  YouTubeSearchNotice,
} from '@/lib/contracts/youtube-search';
import {
  formatItalianDateWithArticle,
  formatItalianTime,
  nextYouTubeQuotaReset,
  youtubeResultsUrl,
} from '@/lib/music/youtube-query';
import styles from './youtube-search-notice.module.css';

type SearchResponse = Pick<YouTubeMusicSearchResponse, 'outcome' | 'videos' | 'sourceStatus'> & {
  youtube?: YouTubeSearchNotice;
};

/** After YouTube said it is busy (or failed), "Riprova" waits this long: each try costs searches. */
export const YOUTUBE_RETRY_DELAY_MS = 15_000;

/** signIn: the connection's searches are used up; signing in gives the listener their own. */
export type YouTubeSearchState =
  | { kind: 'live' }
  | { kind: 'no_results' }
  | { kind: 'saved'; label: string; text: string; retry: boolean; signIn?: true }
  /** quotaOut: the daily searches are used up (not a hiccup), so trying again now is pointless. */
  | { kind: 'blocked'; text: string; retry: boolean; quotaOut: boolean; signIn?: true };

/**
 * Turns a search response into what the listener is told. `scope` 'genre': a genre page, whose
 * fixed searches have their own daily share (listeners may still be able to search).
 */
export function describeYouTubeSearch(
  response: SearchResponse,
  now: Date = new Date(),
  scope: 'search' | 'genre' = 'search',
): YouTubeSearchState {
  const reason = response.sourceStatus.unavailableReason;
  const limit = response.youtube?.limit ?? (reason === 'quota_exceeded' ? 'everyone' : null);
  const reset = `verso le ${formatItalianTime(response.youtube?.resetsAt ?? nextYouTubeQuotaReset(now))}`;
  const connection = `Le ricerche YouTube per questa connessione sono finite per oggi: tornano ${reset}. Accedi per avere le tue.`;

  if (response.videos.length > 0) {
    const savedAt = response.youtube?.freshness === 'saved' ? response.youtube.savedAt : null;
    if (!savedAt) return { kind: 'live' };
    // The date is in the label only: the text says why these are not live results.
    const label = `Risultati salvati ${formatItalianDateWithArticle(savedAt)}`;
    switch (limit) {
      case 'personal':
        return {
          kind: 'saved',
          label,
          retry: false,
          text: `Hai usato le tue ricerche YouTube di oggi: tornano ${reset}.`,
        };
      case 'connection':
        return { kind: 'saved', label, retry: false, text: connection, signIn: true };
      case 'everyone':
        return {
          kind: 'saved',
          label,
          retry: false,
          text: `La ricerca YouTube in tempo reale torna ${reset}.`,
        };
      case 'busy':
        return {
          kind: 'saved',
          label,
          retry: true,
          text: 'YouTube è momentaneamente occupato. Riprova tra poco.',
        };
      default:
        return {
          kind: 'saved',
          label,
          retry: true,
          text: 'YouTube non risponde in questo momento. Riprova tra poco.',
        };
    }
  }

  if (response.outcome !== 'unavailable') return { kind: 'no_results' };
  const elsewhere =
    'Puoi cercare direttamente su YouTube; qui sotto trovi brani Audius, radio e altro da ascoltare subito.';
  switch (limit) {
    case 'personal':
      return {
        kind: 'blocked',
        retry: false,
        quotaOut: true,
        text: `Hai usato le tue ricerche YouTube di oggi: tornano ${reset}. ${elsewhere}`,
      };
    case 'connection':
      return {
        kind: 'blocked',
        retry: false,
        quotaOut: true,
        signIn: true,
        text: `${connection} ${elsewhere}`,
      };
    case 'everyone':
      return {
        kind: 'blocked',
        retry: false,
        quotaOut: true,
        text:
          scope === 'genre'
            ? `I brani YouTube di questo genere non si possono caricare ora: tornano ${reset}. ${elsewhere}`
            : `Le ricerche YouTube di oggi sono finite per tutti: tornano ${reset}. ${elsewhere}`,
      };
    case 'busy':
      return {
        kind: 'blocked',
        retry: true,
        quotaOut: false,
        text: 'YouTube è momentaneamente occupato, riprova tra poco.',
      };
    default:
      return reason === 'not_configured'
        ? {
            kind: 'blocked',
            retry: false,
            quotaOut: false,
            text: `La ricerca YouTube non è attiva. ${elsewhere}`,
          }
        : {
            kind: 'blocked',
            retry: true,
            quotaOut: false,
            text: 'YouTube non è disponibile in questo momento. Riprova tra poco o cerca direttamente su YouTube.',
          };
  }
}

/** Opens YouTube's own search page in a new tab: no API data, no quota. */
export function YouTubeLinkOut({ query }: { query: string }) {
  return (
    // min-w-0 + truncate: a long query ends with "…" instead of widening the page on a phone.
    <Button asChild variant="outline" size="sm" className="min-w-0 max-w-full">
      <a href={youtubeResultsUrl(query)} target="_blank" rel="noopener noreferrer">
        <ExternalLink aria-hidden="true" />
        <span className="truncate">Cerca «{query}» su YouTube</span>
        <span className="sr-only"> (si apre in una nuova scheda)</span>
      </a>
    </Button>
  );
}

/** "Riprova", disabled for `delayMs` after it appears (a quick second try would fail the same way). */
export function YouTubeRetryButton({
  onRetry,
  delayMs = 0,
}: {
  onRetry: () => void;
  delayMs?: number;
}) {
  const [ready, setReady] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) {
      setReady(true);
      return;
    }
    setReady(false);
    const timer = window.setTimeout(() => setReady(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onRetry} disabled={!ready}>
      <RotateCw aria-hidden="true" /> Riprova
    </Button>
  );
}

/** "Accedi", back to this page afterwards (to the same search on the search page). */
function YouTubeSignInLink({ query }: { query: string }) {
  const pathname = usePathname() ?? '/search';
  const back = pathname === '/search' ? `/search?q=${encodeURIComponent(query)}` : pathname;
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={`/login?callbackURL=${encodeURIComponent(back)}`}>Accedi</Link>
    </Button>
  );
}

/**
 * The link to YouTube's search, plus "Accedi" when signing in gives the listener their own
 * searches, plus (when the daily searches are used up) the places where YouTube music still
 * plays without a new search, plus "Riprova" when trying again makes sense.
 */
export function YouTubeLinkRow({
  query,
  quotaOut = false,
  signIn = false,
  onRetry,
  retryDelayMs = 0,
}: {
  query: string;
  quotaOut?: boolean;
  signIn?: boolean;
  onRetry?: () => void;
  retryDelayMs?: number;
}) {
  return (
    <div className={styles.actions}>
      {signIn ? <YouTubeSignInLink query={query} /> : null}
      <YouTubeLinkOut query={query} />
      {quotaOut ? (
        <>
          <Button asChild variant="ghost" size="sm">
            <Link href="/#tendenze">Classifiche</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/generi">Generi e playlist</Link>
          </Button>
        </>
      ) : null}
      {onRetry ? <YouTubeRetryButton onRetry={onRetry} delayMs={retryDelayMs} /> : null}
    </div>
  );
}

/**
 * The notice box. It has no live region of its own (it appears together with its text, so screen
 * readers would not announce it): pages keep one status line always mounted for that.
 */
export function YouTubeSearchNoticeBox({
  query,
  text,
  label,
  quotaOut,
  signIn,
  onRetry,
  retryDelayMs,
}: {
  query: string;
  text: string;
  label?: string;
  quotaOut?: boolean;
  signIn?: boolean;
  onRetry?: () => void;
  retryDelayMs?: number;
}) {
  return (
    <div className={styles.notice}>
      {label ? <p className={styles.savedLabel}>{label}</p> : null}
      <p>{text}</p>
      <YouTubeLinkRow
        query={query}
        quotaOut={quotaOut}
        signIn={signIn}
        onRetry={onRetry}
        retryDelayMs={retryDelayMs}
      />
    </div>
  );
}

/** What the always-mounted status line says for a state (for screen readers). */
export function youtubeStatusText(state: YouTubeSearchState, count: number): string {
  const results = `${count} ${count === 1 ? 'risultato' : 'risultati'}.`;
  switch (state.kind) {
    case 'live':
      return results;
    case 'saved':
      return `${state.label}. ${results}`;
    case 'no_results':
      return 'Nessun risultato.';
    default:
      return state.text;
  }
}
