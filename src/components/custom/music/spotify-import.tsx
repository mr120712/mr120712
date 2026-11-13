// @polsia:user-owned — "Importa da Spotify": l'utente collega il suo account Spotify
// (Authorization Code con PKCE, tutto lato server: i token non arrivano mai al browser), sceglie
// fino a 5 playlist e/o i brani salvati e ne trasferisce i metadati in playlist Solco. L'elenco
// delle playlist arriva da Spotify quando si apre la scelta e non viene salvato da nessuna parte.
'use client';

import { Heart, ListMusic } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  ConnectionStatusSchema,
  SPOTIFY_ACCOUNT_APPS_URL,
  SPOTIFY_IMPORT_MAX_SOURCES,
  SPOTIFY_OPEN_URL,
  SPOTIFY_PLAYLISTS_PAGE_SIZE,
  type SpotifyCallbackReason,
  SpotifyCallbackReasonSchema,
  type SpotifyImportRequest,
  type SpotifyImportResponse,
  SpotifyImportResponseSchema,
  type SpotifyPlaylistsResponse,
  SpotifyPlaylistsResponseSchema,
  SpotifySyncResponseSchema,
} from '@/lib/contracts/spotify';
import styles from './spotify-import.module.css';

const LOGIN_PATH = '/api/spotify/login';
const SPOTIFY_SAVED_TRACKS_URL = `${SPOTIFY_OPEN_URL}/collection/tracks`;
/** Wait after a 429 that carries no retryAfterSeconds ("Riprova tra qualche secondo"). */
const DEFAULT_RETRY_SECONDS = 5;
/** Upper bound for the client-side wait (setTimeout overflows past ~24 days). */
const MAX_RETRY_SECONDS = 86_400;

/** outdated: still connected, but with an older consent that lacks a scope Solco now needs. */
type Status = 'loading' | 'hidden' | 'disconnected' | 'connected' | 'reauth' | 'outdated';
type CreatedPlaylist = SpotifyImportResponse['created'][number];
type FailedSource = SpotifyImportResponse['failed'][number];
/** A page of playlists together with the offset it was loaded from. */
type LoadedPage = SpotifyPlaylistsResponse & { offset: number };
/** After a 429 nothing calls Spotify again until `until` (Date.now() ms). */
type Cooldown = { until: number; message: string };

/** Italian copy for the fixed `reason` values /api/spotify/callback can send back. */
const CALLBACK_ERRORS: Record<SpotifyCallbackReason, string> = {
  denied: 'Hai annullato il collegamento: Spotify non ha condiviso nessun dato.',
  expired: 'Il collegamento a Spotify è scaduto. Riprova da questa pagina.',
  invalid_state: 'Non è stato possibile verificare il collegamento a Spotify. Riprova.',
  session: 'Accedi a Solco con lo stesso account con cui hai avviato il collegamento e riprova.',
  not_allowlisted:
    'Questo account Spotify non è ancora tra gli utenti autorizzati dell’app Solco su Spotify (l’app è in modalità sviluppo).',
  rate_limited: 'Spotify sta ricevendo troppe richieste. Riprova tra qualche minuto.',
  failed: 'Spotify non ha confermato il collegamento. Riprova tra poco.',
};

function callbackErrorMessage(reason: string | null) {
  const parsed = SpotifyCallbackReasonSchema.safeParse(reason);
  return parsed.success
    ? CALLBACK_ERRORS[parsed.data]
    : 'Collegamento a Spotify non riuscito. Riprova.';
}

type ErrorBody = { error?: unknown; message?: unknown; retryAfterSeconds?: unknown };

function errorBody(error: unknown): ErrorBody | null {
  return error instanceof Error && typeof error.cause === 'object' && error.cause !== null
    ? (error.cause as ErrorBody)
    : null;
}

/** apiFetch puts the HTTP status at the end of its message: "apiFetch /x failed (429)". */
function errorStatus(error: unknown) {
  const match = error instanceof Error ? /\((\d{3})\)$/.exec(error.message) : null;
  return match ? Number(match[1]) : null;
}

function needsReauth(error: unknown) {
  return errorBody(error)?.error === 'spotify_reauth';
}

function needsNewConsent(error: unknown) {
  return errorBody(error)?.error === 'spotify_scope_outdated';
}

/** The server's own Italian message (it includes Spotify's when useful), else the fallback. */
function errorMessage(error: unknown, fallback: string) {
  const body = errorBody(error);
  const message =
    typeof body?.message === 'string' && body.message.trim()
      ? body.message.trim().slice(0, 300)
      : null;
  if (errorStatus(error) === 429) {
    const seconds =
      typeof body?.retryAfterSeconds === 'number' && body.retryAfterSeconds > 0
        ? Math.ceil(body.retryAfterSeconds)
        : null;
    const base = message ?? 'Troppe richieste a Spotify.';
    if (seconds !== null && !base.includes(String(seconds))) {
      return `${base} Riprova tra ${seconds} ${seconds === 1 ? 'secondo' : 'secondi'}.`;
    }
    return seconds === null && !message ? `${base} Riprova tra qualche secondo.` : base;
  }
  return message ?? fallback;
}

/** 429 codes that mean Spotify itself is limiting Solco: they pause every call to Spotify. */
const SPOTIFY_LIMIT_ERRORS = new Set(['spotify_rate_limited', 'spotify_quota_exceeded']);

/** Note beside "Importa in Solco" while Solco's own import limit is in force. */
function importWaitNote(until: number) {
  // The note is rendered once and not updated while it is on screen, so it never counts down:
  // under a minute it says so, otherwise it names the first whole minute when importing works
  // again (rounded up: 10:09:46 → "dalle 10:10", never a minute that is still blocked).
  let when = 'tra meno di un minuto';
  if (until - Date.now() >= 60_000) {
    const end = new Date(Math.ceil(until / 60_000) * 60_000);
    const time = end.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    when = `${end.toDateString() === new Date().toDateString() ? '' : 'domani '}dalle ${time}`;
  }
  return `Hai raggiunto il limite di importazioni: potrai importare di nuovo ${when}. Intanto puoi continuare a sfogliare e scegliere le playlist.`;
}

/** Seconds to wait before calling Spotify again after a 429 (Retry-After), else null. */
function retryAfterSeconds(error: unknown) {
  if (errorStatus(error) !== 429) return null;
  const seconds = errorBody(error)?.retryAfterSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.ceil(seconds), MAX_RETRY_SECONDS)
    : DEFAULT_RETRY_SECONDS;
}

/** Only open.spotify.com links leave the page; anything else falls back to the playlist id. */
function playlistUrl(id: string, url: string) {
  return url.startsWith(`${SPOTIFY_OPEN_URL}/`) ? url : `${SPOTIFY_OPEN_URL}/playlist/${id}`;
}

function songs(count: number) {
  return count === 1 ? '1 brano' : `${count} brani`;
}

function createdNotes(playlist: CreatedPlaylist) {
  const notes = [
    playlist.skipped ? `${playlist.skipped} saltati` : '',
    playlist.truncated ? `${playlist.truncated} oltre il limite di 200` : '',
  ].filter(Boolean);
  return notes.length ? ` (${notes.join(', ')})` : '';
}

function importSummary(created: CreatedPlaylist[]) {
  const [first] = created;
  if (created.length === 1 && first) {
    return `“${first.name}” importata in Solco: ${songs(first.imported)}${createdNotes(first)}.`;
  }
  const total = created.reduce((sum, playlist) => sum + playlist.imported, 0);
  return `${created.length} playlist importate in Solco: ${songs(total)} in tutto.`;
}

function failureSummary(failed: FailedSource[]) {
  const [first] = failed;
  if (failed.length === 1 && first) return first.message;
  return `${failed.length} elementi non importati: ${failed.map((item) => item.message).join(' ')}`;
}

/** Riassunto di un aggiornamento (sincronizzazione) da Spotify: quante playlist, +aggiunti −rimossi. */
function syncSummary(updated: CreatedPlaylist[]) {
  const added = updated.reduce((sum, playlist) => sum + playlist.added, 0);
  const removed = updated.reduce((sum, playlist) => sum + playlist.removed, 0);
  const [first] = updated;
  const base =
    updated.length === 1 && first
      ? `“${first.name}” aggiornata`
      : `${updated.length} playlist aggiornate`;
  const deltas = [added ? `+${songs(added)}` : null, removed ? `−${songs(removed)}` : null]
    .filter(Boolean)
    .join(', ');
  return deltas ? `${base}: ${deltas}.` : `${base}: già allineate, nessuna novità.`;
}

/** Messaggio combinato quando un'operazione crea e/o aggiorna playlist. */
function changeSummary(created: CreatedPlaylist[], updated: CreatedPlaylist[]) {
  const parts: string[] = [];
  if (created.length) parts.push(importSummary(created));
  if (updated.length) parts.push(syncSummary(updated));
  return parts.join(' ');
}

/**
 * Official Spotify logo files (public/brand/spotify). Both monochrome variants are in the
 * markup and CSS shows the one that contrasts with the card: white on the dark theme
 * (src/lib/color-theme.ts is 'dark'), black on a light one. Green is never used: the card
 * background is not pure black or white.
 */
function SpotifyMark({ kind, alt }: { kind: 'full' | 'icon'; alt: string }) {
  const file = kind === 'full' ? 'full-logo' : 'primary-logo';
  const size = kind === 'full' ? { width: 132, height: 36 } : { width: 24, height: 23 };
  const className = kind === 'full' ? styles.logo : styles.icon;
  return (
    <>
      <Image
        src={`/brand/spotify/${file}-black.svg`}
        alt={alt}
        {...size}
        unoptimized
        className={`${className} block dark:hidden`}
      />
      <Image
        src={`/brand/spotify/${file}-white.svg`}
        alt={alt}
        {...size}
        unoptimized
        className={`${className} hidden dark:block`}
      />
    </>
  );
}

function SpotifyLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={styles.spotifyLink} href={href} target="_blank" rel="noopener noreferrer">
      <SpotifyMark kind="icon" alt="" />
      {children}
      <span className="sr-only"> (si apre in una nuova scheda)</span>
    </a>
  );
}

export function SpotifyImport({ onImported }: { onImported: () => void }) {
  const baseId = useId();
  const ids = {
    title: `${baseId}-title`,
    chooser: `${baseId}-chooser`,
    hint: `${baseId}-hint`,
    saved: `${baseId}-saved`,
  };
  const [status, setStatus] = useState<Status>('loading');
  const [open, setOpen] = useState(false);
  // The page the user asked for; `page.offset` is the one actually on screen (they differ
  // after a failed load, and the labels and the pager follow what is on screen).
  const [requestedOffset, setRequestedOffset] = useState(0);
  const [page, setPage] = useState<LoadedPage | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState<Cooldown | null>(null);
  const cooldownRef = useRef<Cooldown | null>(null);
  // Solco's own import limit (429 rate_limited): only "Importa in Solco" waits, the list does not.
  const [importBlockedUntil, setImportBlockedUntil] = useState<number | null>(null);
  const importBlockedRef = useRef<number | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [created, setCreated] = useState<CreatedPlaylist[]>([]);
  const [failed, setFailed] = useState<FailedSource[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const requestRef = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  const focusListRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusTitleRef = useRef(false);
  const coolingDown = cooldown !== null;

  // Back from /api/spotify/callback: say how it went once, then drop the query from the URL.
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('spotify');
    if (!outcome) return;
    if (outcome === 'connected') {
      toast.success('Spotify collegato.');
      setOpen(true);
    } else if (outcome === 'error') {
      toast.error(callbackErrorMessage(url.searchParams.get('reason')));
    }
    url.searchParams.delete('spotify');
    url.searchParams.delete('reason');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    let active = true;
    apiFetch('/api/spotify/connection', { schema: ConnectionStatusSchema, cache: 'no-store' })
      .then((connection) => {
        if (!active) return;
        if (!connection.configured) setStatus('hidden');
        else if (!connection.connected) setStatus('disconnected');
        else setStatus(connection.needsReconnect ? 'outdated' : 'connected');
      })
      .catch(() => {
        // Signed out, feature off or server trouble: the card simply does not appear.
        if (active) setStatus('hidden');
      });
    return () => {
      active = false;
    };
  }, []);

  const askReauth = useCallback(() => {
    focusTitleRef.current = true;
    setStatus('reauth');
  }, []);

  /** Older consent without a scope Solco now needs: the server keeps it until the listener acts. */
  const askNewConsent = useCallback((error: unknown) => {
    focusTitleRef.current = true;
    setStatus('outdated');
    toast.error(errorMessage(error, 'Ricollega Spotify per continuare.'));
  }, []);

  /** Honour Retry-After: after a 429, no request reaches Spotify until the wait is over. */
  const startCooldown = useCallback((error: unknown, message: string) => {
    const seconds = retryAfterSeconds(error);
    if (seconds === null) return;
    const next = { until: Date.now() + seconds * 1000, message };
    cooldownRef.current = next;
    setCooldown(next);
  }, []);

  const activeCooldown = useCallback(() => {
    const current = cooldownRef.current;
    return current && current.until > Date.now() ? current : null;
  }, []);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(
      () => {
        cooldownRef.current = null;
        setCooldown(null);
      },
      Math.max(0, cooldown.until - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const importBlocked = useCallback(() => {
    const until = importBlockedRef.current;
    return until !== null && until > Date.now();
  }, []);

  useEffect(() => {
    if (importBlockedUntil === null) return;
    const timer = window.setTimeout(
      () => {
        importBlockedRef.current = null;
        setImportBlockedUntil(null);
      },
      Math.max(0, importBlockedUntil - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [importBlockedUntil]);

  const loadPage = useCallback(
    async (offset: number) => {
      const waiting = activeCooldown();
      if (waiting) {
        // Keep the wait visible with its (disabled until the end) "Riprova".
        setListError(waiting.message);
        return;
      }
      const request = ++requestRef.current;
      setLoadingList(true);
      setListError(null);
      try {
        const result = await apiFetch(`/api/spotify/playlists?offset=${offset}`, {
          schema: SpotifyPlaylistsResponseSchema,
          cache: 'no-store',
        });
        if (request !== requestRef.current) return;
        setPage({ ...result, offset });
      } catch (error) {
        if (request !== requestRef.current) return;
        if (needsReauth(error)) {
          askReauth();
          return;
        }
        if (needsNewConsent(error)) {
          askNewConsent(error);
          return;
        }
        const message = errorMessage(
          error,
          'Non è stato possibile leggere le tue playlist da Spotify. Riprova.',
        );
        startCooldown(error, message);
        setListError(message);
      } finally {
        if (request === requestRef.current) setLoadingList(false);
      }
    },
    [activeCooldown, askNewConsent, askReauth, startCooldown],
  );

  // The playlist list is read live from Spotify only while the chooser is open; closing it
  // drops it (nothing from Spotify is kept beyond immediate use).
  useEffect(() => {
    if (status !== 'connected' || !open) {
      requestRef.current += 1;
      setPage(null);
      setLoadingList(false);
      return;
    }
    void loadPage(requestedOffset);
  }, [status, open, requestedOffset, loadPage]);

  // After "Altre playlist" / "Playlist precedenti", move focus to the new page of the list.
  useEffect(() => {
    if (page && focusListRef.current) {
      focusListRef.current = false;
      listRef.current?.focus();
    }
  }, [page]);

  // When the controls the user was on disappear (disconnect, reconnect needed), land on the title.
  useEffect(() => {
    if (
      focusTitleRef.current &&
      (status === 'disconnected' || status === 'reauth' || status === 'outdated')
    ) {
      focusTitleRef.current = false;
      titleRef.current?.focus();
    }
  }, [status]);

  const goTo = (offset: number) => {
    if (loadingList || activeCooldown()) return;
    focusListRef.current = true;
    // Same offset as the last request: that load failed, so the effect will not run again.
    if (offset === requestedOffset) void loadPage(offset);
    else setRequestedOffset(offset);
  };

  const chosen = selected.length + (saved ? 1 : 0);
  const limitReached = chosen >= SPOTIFY_IMPORT_MAX_SOURCES;

  const toggle = (id: string, name: string, checked: boolean, importable: boolean) => {
    if (!checked) {
      setSelected((previous) => previous.filter((value) => value !== id));
      return;
    }
    if (!importable || selected.includes(id) || limitReached) return;
    setSelected([...selected, id]);
    setNames((previous) => ({ ...previous, [id]: name }));
  };

  const runImport = async (event: FormEvent) => {
    event.preventDefault();
    if (importing || chosen === 0 || activeCooldown() || importBlocked()) return;
    setImporting(true);
    setCreated([]);
    setFailed([]);
    try {
      const result = await apiFetch('/api/spotify/import', {
        method: 'POST',
        body: JSON.stringify({ playlistIds: selected, saved } satisfies SpotifyImportRequest),
        schema: SpotifyImportResponseSchema,
      });
      // `failed`/`updated` have schema defaults; apiFetch's typing exposes the pre-default shape.
      const notImported = result.failed ?? [];
      // Una sorgente già importata viene AGGIORNATA (stessa playlist), non duplicata.
      const updatedList = result.updated ?? [];
      setCreated([...result.created, ...updatedList]);
      setFailed(notImported);
      setSelected([]);
      setSaved(false);
      if (result.created.length || updatedList.length) {
        toast.success(changeSummary(result.created, updatedList));
        onImported();
      }
      if (notImported.length) toast.error(failureSummary(notImported));
      // Access revoked mid-import: the server already deleted the tokens, so offer to reconnect.
      if (notImported.some((item) => item.error === 'spotify_reauth')) askReauth();
    } catch (error) {
      if (needsReauth(error)) {
        askReauth();
        toast.error('La connessione con Spotify è scaduta: ricollega Spotify per importare.');
        return;
      }
      if (needsNewConsent(error)) {
        askNewConsent(error);
        return;
      }
      const message = errorMessage(error, 'Importazione da Spotify non riuscita. Riprova.');
      const code = errorBody(error)?.error;
      if (typeof code === 'string' && SPOTIFY_LIMIT_ERRORS.has(code)) {
        startCooldown(error, message);
      } else {
        // Solco's own import limit (shared with the other imports): the playlist list is a
        // separate limit, so browsing and choosing stay possible during the wait.
        const seconds = retryAfterSeconds(error);
        if (seconds !== null) {
          const until = Date.now() + seconds * 1000;
          importBlockedRef.current = until;
          setImportBlockedUntil(until);
        }
      }
      toast.error(message);
    } finally {
      setImporting(false);
    }
  };

  // Gestione errori condivisa fra importazione e aggiornamento (reauth, nuovo consenso, limiti).
  const handleSpotifyActionError = (error: unknown, fallback: string) => {
    if (needsReauth(error)) {
      askReauth();
      toast.error('La connessione con Spotify è scaduta: ricollega Spotify per continuare.');
      return;
    }
    if (needsNewConsent(error)) {
      askNewConsent(error);
      return;
    }
    const message = errorMessage(error, fallback);
    const code = errorBody(error)?.error;
    if (typeof code === 'string' && SPOTIFY_LIMIT_ERRORS.has(code)) {
      startCooldown(error, message);
    } else {
      const seconds = retryAfterSeconds(error);
      if (seconds !== null) {
        const until = Date.now() + seconds * 1000;
        importBlockedRef.current = until;
        setImportBlockedUntil(until);
      }
    }
    toast.error(message);
  };

  // "Aggiorna da Spotify": risincronizza libreria + playlist importate (nessuna scelta da fare).
  const runSync = async () => {
    if (importing || syncing || activeCooldown() || importBlocked()) return;
    setSyncing(true);
    setCreated([]);
    setFailed([]);
    try {
      const result = await apiFetch('/api/spotify/sync', {
        method: 'POST',
        schema: SpotifySyncResponseSchema,
      });
      const notSynced = result.failed ?? [];
      const updatedList = result.updated ?? [];
      setCreated(updatedList);
      setFailed(notSynced);
      if (result.nothingToSync) {
        toast(
          'Non hai ancora importato nulla da Spotify: scegli prima le playlist o i brani salvati.',
        );
      } else if (updatedList.length) {
        toast.success(syncSummary(updatedList));
        onImported();
      } else if (notSynced.length === 0) {
        toast('Le tue playlist Solco sono già allineate a Spotify.');
      }
      if (notSynced.length) toast.error(failureSummary(notSynced));
      if (notSynced.some((item) => item.error === 'spotify_reauth')) askReauth();
    } catch (error) {
      handleSpotifyActionError(error, 'Aggiornamento da Spotify non riuscito. Riprova.');
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await apiFetch('/api/spotify/connection', {
        method: 'DELETE',
        schema: ConnectionStatusSchema,
      });
      focusTitleRef.current = true;
      setStatus('disconnected');
      setOpen(false);
      setRequestedOffset(0);
      setSelected([]);
      setSaved(false);
      setCreated([]);
      setFailed([]);
      setDisconnected(true);
      toast.success('Spotify scollegato.');
    } catch (error) {
      toast.error(errorMessage(error, 'Non è stato possibile scollegare Spotify. Riprova.'));
    } finally {
      setDisconnecting(false);
    }
  };

  if (status === 'loading' || status === 'hidden') return null;

  const playlists = page?.playlists.slice(0, SPOTIFY_PLAYLISTS_PAGE_SIZE) ?? [];
  const chosenOnOtherPages = selected.filter(
    (id) => !playlists.some((playlist) => playlist.id === id),
  );
  const firstNumber = (page?.offset ?? 0) + 1;
  const lastNumber = (page?.offset ?? 0) + playlists.length;
  const previousOffset =
    page && page.offset > 0 ? Math.max(0, page.offset - SPOTIFY_PLAYLISTS_PAGE_SIZE) : null;
  const progress = importing
    ? 'Importazione in corso: Solco sta leggendo i brani da Spotify. Può richiedere fino a un minuto.'
    : syncing
      ? 'Aggiornamento in corso: Solco sta risincronizzando le tue playlist con Spotify. Può richiedere fino a un minuto.'
      : loadingList
        ? 'Caricamento delle playlist da Spotify…'
        : created.length || failed.length
          ? 'Operazione completata.'
          : '';

  return (
    <section className={styles.card} aria-labelledby={ids.title}>
      <div className={styles.header}>
        <SpotifyMark kind="full" alt="Spotify" />
        <h2 id={ids.title} ref={titleRef} tabIndex={-1} className={styles.title}>
          Importa da Spotify
        </h2>
      </div>

      {status === 'disconnected' ? (
        <>
          <p className={styles.text}>Porta in Solco le tue playlist Spotify e i brani salvati.</p>
          <p className={styles.hint}>
            Solco chiede a Spotify solo di leggere le tue playlist e i brani salvati, non modifica
            nulla sul tuo account e salva soltanto le playlist che scegli di importare.{' '}
            <Link href="/privacy">Informativa privacy</Link>
          </p>
          <div className={styles.actions}>
            <Button asChild>
              <a href={LOGIN_PATH}>Accedi con Spotify</a>
            </Button>
          </div>
          {disconnected ? (
            <output className={styles.note}>
              Spotify è scollegato: Solco ha cancellato i token di accesso. Le playlist già
              importate restano nella tua Libreria. Per revocare l’accesso anche da Spotify, vai su{' '}
              <a href={SPOTIFY_ACCOUNT_APPS_URL} target="_blank" rel="noopener noreferrer">
                spotify.com/account/apps
              </a>
              .
            </output>
          ) : null}
        </>
      ) : null}

      {status === 'reauth' ? (
        <>
          <p className={styles.text} role="alert">
            La connessione con Spotify è scaduta o è stata revocata. Ricollega Spotify per
            continuare: le playlist già importate restano nella tua Libreria.
          </p>
          <div className={styles.actions}>
            <Button asChild>
              <a href={LOGIN_PATH}>Ricollega Spotify</a>
            </Button>
          </div>
        </>
      ) : null}

      {status === 'outdated' ? (
        <>
          <p className={styles.text}>
            Spotify è collegato con un consenso precedente, che non include le playlist di cui sei
            collaboratore. Ricollega Spotify per vedere anche quelle: le playlist già importate
            restano nella tua Libreria.
          </p>
          <div className={styles.actions}>
            <Button asChild>
              <a href={LOGIN_PATH}>Ricollega Spotify</a>
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={disconnecting}
              onClick={() => void disconnect()}
            >
              {disconnecting ? 'Scollegamento…' : 'Disconnetti Spotify'}
            </Button>
          </div>
        </>
      ) : null}

      {status === 'connected' ? (
        <>
          <p className={styles.text}>
            Spotify è collegato. Scegli fino a {SPOTIFY_IMPORT_MAX_SOURCES} elementi fra i brani
            salvati e le playlist che hai creato o di cui sei collaboratore: Solco crea una playlist
            per ciascuno (al massimo 200 brani) e cerca ogni brano su YouTube quando lo ascolti.
          </p>
          <div className={styles.actions}>
            <Button
              type="button"
              variant={open ? 'outline' : 'default'}
              aria-expanded={open}
              aria-controls={ids.chooser}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? 'Nascondi le playlist' : 'Scegli le playlist'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={importing || syncing || coolingDown || importBlockedUntil !== null}
              onClick={() => void runSync()}
              title="Risincronizza i brani salvati e le playlist già importate con la tua libreria Spotify"
            >
              {syncing ? 'Aggiornamento…' : 'Aggiorna da Spotify'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={disconnecting || importing || syncing}
              onClick={() => void disconnect()}
            >
              {disconnecting ? 'Scollegamento…' : 'Disconnetti Spotify'}
            </Button>
          </div>

          <form
            id={ids.chooser}
            hidden={!open}
            className={styles.chooser}
            aria-busy={importing || loadingList}
            onSubmit={(event) => void runImport(event)}
          >
            {listError ? (
              <div className={styles.note} role="alert">
                <p className={styles.text}>{listError}</p>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loadingList || coolingDown}
                    onClick={() => void loadPage(requestedOffset)}
                  >
                    Riprova
                  </Button>
                </div>
              </div>
            ) : null}

            {page ? (
              <fieldset
                className={styles.fieldset}
                disabled={importing}
                aria-describedby={ids.hint}
              >
                <legend className={styles.legend}>Cosa vuoi importare?</legend>
                <p id={ids.hint} className={styles.hint}>
                  {limitReached ? (
                    <span className={styles.hintStrong}>
                      Hai scelto {SPOTIFY_IMPORT_MAX_SOURCES} elementi, il massimo per
                      un’importazione: togline uno per sceglierne un altro.
                    </span>
                  ) : (
                    `Puoi scegliere fino a ${SPOTIFY_IMPORT_MAX_SOURCES} elementi per volta (i brani salvati contano come uno). Ognuno porta in Solco al massimo 200 brani.`
                  )}
                </p>

                <div className={styles.item}>
                  <input
                    id={ids.saved}
                    type="checkbox"
                    className={styles.check}
                    checked={saved}
                    disabled={!saved && limitReached}
                    onChange={(event) => setSaved(event.target.checked)}
                  />
                  <label htmlFor={ids.saved} className={styles.label}>
                    <span className={styles.coverFallback} aria-hidden="true">
                      <Heart />
                    </span>
                    <span className={styles.itemText}>
                      <span className={styles.itemName}>Brani salvati ({page.savedTracks})</span>
                      <span className={styles.itemMeta}>I brani che hai salvato su Spotify</span>
                    </span>
                  </label>
                  <SpotifyLink href={SPOTIFY_SAVED_TRACKS_URL}>Apri in Spotify</SpotifyLink>
                </div>

                {playlists.length ? (
                  <ul
                    ref={listRef}
                    tabIndex={-1}
                    className={styles.list}
                    aria-label={`Le tue playlist Spotify, da ${firstNumber} a ${lastNumber}`}
                  >
                    {playlists.map((playlist) => {
                      const inputId = `${baseId}-playlist-${playlist.id}`;
                      const checked = selected.includes(playlist.id);
                      return (
                        <li
                          key={playlist.id}
                          className={styles.item}
                          data-importable={playlist.importable ? undefined : 'false'}
                        >
                          <input
                            id={inputId}
                            type="checkbox"
                            className={styles.check}
                            checked={checked}
                            disabled={!checked && (limitReached || !playlist.importable)}
                            onChange={(event) =>
                              toggle(
                                playlist.id,
                                playlist.name,
                                event.target.checked,
                                playlist.importable,
                              )
                            }
                          />
                          <label htmlFor={inputId} className={styles.label}>
                            {playlist.imageUrl ? (
                              <Image
                                src={playlist.imageUrl}
                                alt=""
                                width={52}
                                height={52}
                                unoptimized
                                className={styles.cover}
                              />
                            ) : (
                              <span className={styles.coverFallback} aria-hidden="true">
                                <ListMusic />
                              </span>
                            )}
                            <span className={styles.itemText}>
                              <span className={styles.itemName} title={playlist.name}>
                                {playlist.name}
                              </span>
                              {playlist.owner || playlist.itemCount !== null ? (
                                <span className={styles.itemMeta}>
                                  {[
                                    playlist.owner ? `di ${playlist.owner}` : '',
                                    playlist.itemCount !== null ? songs(playlist.itemCount) : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                              ) : null}
                              {playlist.importable ? null : (
                                // Inside the label: part of the checkbox's accessible name, so
                                // every screen reader says why it cannot be chosen.
                                <span className={styles.itemMeta}>
                                  Non importabile: Spotify consente di importare solo le playlist
                                  create da te o di cui sei collaboratore.
                                </span>
                              )}
                            </span>
                          </label>
                          <SpotifyLink href={playlistUrl(playlist.id, playlist.spotifyUrl)}>
                            Apri in Spotify<span className="sr-only">: {playlist.name}</span>
                          </SpotifyLink>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className={styles.hint}>Su Spotify non ci sono altre playlist da mostrare.</p>
                )}
              </fieldset>
            ) : null}

            {page ? (
              <div className={styles.pager}>
                <div className={styles.actions}>
                  {previousOffset !== null ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={loadingList || coolingDown}
                      onClick={() => goTo(previousOffset)}
                    >
                      Playlist precedenti
                    </Button>
                  ) : null}
                  {page.nextOffset !== null ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={loadingList || coolingDown}
                      onClick={() => {
                        if (page.nextOffset !== null) goTo(page.nextOffset);
                      }}
                    >
                      Altre playlist
                    </Button>
                  ) : null}
                </div>
                <SpotifyLink href={SPOTIFY_OPEN_URL}>Apri Spotify</SpotifyLink>
              </div>
            ) : null}

            {page ? (
              <div className={styles.actions}>
                <Button
                  type="submit"
                  disabled={importing || chosen === 0 || coolingDown || importBlockedUntil !== null}
                >
                  {importing ? 'Importazione…' : 'Importa in Solco'}
                </Button>
                <span className={styles.hint}>
                  {chosen === 0
                    ? 'Nessuna selezione.'
                    : `Scelti ${chosen} di ${SPOTIFY_IMPORT_MAX_SOURCES}${
                        chosenOnOtherPages.length
                          ? `, anche in altre pagine: ${chosenOnOtherPages
                              .map((id) => `“${names[id] ?? id}”`)
                              .join(', ')}`
                          : ''
                      }.`}
                </span>
              </div>
            ) : null}

            {cooldown && !listError ? <p className={styles.note}>{cooldown.message}</p> : null}
            {page && importBlockedUntil !== null && !cooldown ? (
              <p className={styles.note}>{importWaitNote(importBlockedUntil)}</p>
            ) : null}

            <output className={styles.hint} aria-live="polite">
              {progress}
            </output>

            {created.length || failed.length ? (
              <ul className={styles.results} aria-label="Esito dell’importazione">
                {created.map((playlist) => (
                  <li key={playlist.collectionId}>
                    “{playlist.name}”: {songs(playlist.imported)}
                    {createdNotes(playlist)}. La trovi qui sotto, fra le tue playlist.
                  </li>
                ))}
                {failed.map((item) => (
                  <li key={item.source}>
                    {item.source === 'saved'
                      ? 'Brani salvati'
                      : `“${names[item.source] ?? item.source}”`}
                    : non importata. {item.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </form>

          <footer className={styles.footer}>
            <SpotifyMark kind="icon" alt="" />
            Dati forniti da Spotify
          </footer>
        </>
      ) : null}
    </section>
  );
}
