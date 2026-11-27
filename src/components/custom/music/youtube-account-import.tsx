// @polsia:user-owned — "Connetti YouTube": l'utente collega il suo account YouTube/Google (OAuth,
// tutto lato server: i token non arrivano mai al browser), sceglie fino a 5 delle sue playlist
// (anche private) e ne importa i video come playlist Solco (riferimenti, riprodotti on-demand).
// L'elenco delle playlist arriva da YouTube quando si apre la scelta e non viene salvato.
'use client';

import { ListMusic, Youtube } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  GOOGLE_ACCOUNT_PERMISSIONS_URL,
  YOUTUBE_IMPORT_MAX_SOURCES,
  type YouTubeAccountImportRequest,
  type YouTubeAccountImportResponse,
  YouTubeAccountImportResponseSchema,
  type YouTubeAccountPlaylist,
  type YouTubeCallbackReason,
  YouTubeCallbackReasonSchema,
  YouTubeConnectionStatusSchema,
  YouTubePlaylistsResponseSchema,
  YouTubeSyncResponseSchema,
} from '@/lib/contracts/youtube-account';

const CONNECT_PATH = '/api/music/youtube/connect';

type Status = 'loading' | 'hidden' | 'disconnected' | 'connected' | 'reauth';
type ImportedPlaylist = YouTubeAccountImportResponse['created'][number];
type FailedPlaylist = YouTubeAccountImportResponse['failed'][number];

const CALLBACK_ERRORS: Record<YouTubeCallbackReason, string> = {
  denied: 'Hai annullato il collegamento: YouTube non ha condiviso nessun dato.',
  expired: 'Il collegamento a YouTube è scaduto. Riprova da questa pagina.',
  invalid_state: 'Non è stato possibile verificare il collegamento a YouTube. Riprova.',
  session: 'Accedi a Solco con lo stesso account con cui hai avviato il collegamento e riprova.',
  rate_limited: 'YouTube sta ricevendo troppe richieste. Riprova tra qualche minuto.',
  failed: 'YouTube non ha confermato il collegamento. Riprova tra poco.',
};

function callbackErrorMessage(reason: string | null) {
  const parsed = YouTubeCallbackReasonSchema.safeParse(reason);
  return parsed.success
    ? CALLBACK_ERRORS[parsed.data]
    : 'Collegamento a YouTube non riuscito. Riprova.';
}

type ErrorBody = { error?: unknown; message?: unknown };

function errorBody(error: unknown): ErrorBody | null {
  return error instanceof Error && typeof error.cause === 'object' && error.cause !== null
    ? (error.cause as ErrorBody)
    : null;
}

function needsReauth(error: unknown) {
  return errorBody(error)?.error === 'youtube_reauth';
}

function errorMessage(error: unknown, fallback: string) {
  const body = errorBody(error);
  return typeof body?.message === 'string' && body.message.trim()
    ? body.message.trim().slice(0, 300)
    : fallback;
}

function videos(count: number) {
  return count === 1 ? '1 video' : `${count} video`;
}

function importSummary(created: ImportedPlaylist[]) {
  const [first] = created;
  if (created.length === 1 && first) {
    const extra = first.skipped ? ` (${first.skipped} saltati)` : '';
    return `“${first.name}” importata in Solco: ${videos(first.imported)}${extra}.`;
  }
  const total = created.reduce((sum, playlist) => sum + playlist.imported, 0);
  return `${created.length} playlist importate in Solco: ${videos(total)} in tutto.`;
}

function syncSummary(updated: ImportedPlaylist[]) {
  const added = updated.reduce((sum, playlist) => sum + playlist.added, 0);
  const removed = updated.reduce((sum, playlist) => sum + playlist.removed, 0);
  const [first] = updated;
  const base =
    updated.length === 1 && first
      ? `“${first.name}” aggiornata`
      : `${updated.length} playlist aggiornate`;
  const deltas = [added ? `+${videos(added)}` : null, removed ? `−${videos(removed)}` : null]
    .filter(Boolean)
    .join(', ');
  return deltas ? `${base}: ${deltas}.` : `${base}: già allineate, nessuna novità.`;
}

function changeSummary(created: ImportedPlaylist[], updated: ImportedPlaylist[]) {
  const parts: string[] = [];
  if (created.length) parts.push(importSummary(created));
  if (updated.length) parts.push(syncSummary(updated));
  return parts.join(' ');
}

function failureSummary(failed: FailedPlaylist[]) {
  const [first] = failed;
  if (failed.length === 1 && first) return first.message;
  return `${failed.length} playlist non importate: ${failed.map((item) => item.message).join(' ')}`;
}

export function YouTubeAccountImport({ onImported }: { onImported: () => void }) {
  const baseId = useId();
  const chooserId = `${baseId}-chooser`;
  const [status, setStatus] = useState<Status>('loading');
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<YouTubeAccountPlaylist[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Back from /api/music/youtube/callback: say how it went once, then drop the query from the URL.
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('youtube');
    if (!outcome) return;
    if (outcome === 'connected') {
      toast.success('YouTube collegato.');
      setOpen(true);
    } else if (outcome === 'error') {
      toast.error(callbackErrorMessage(url.searchParams.get('reason')));
    }
    url.searchParams.delete('youtube');
    url.searchParams.delete('reason');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    let active = true;
    apiFetch('/api/music/youtube/connection', {
      schema: YouTubeConnectionStatusSchema,
      cache: 'no-store',
    })
      .then((connection) => {
        if (!active) return;
        if (!connection.configured) setStatus('hidden');
        else setStatus(connection.connected ? 'connected' : 'disconnected');
      })
      .catch(() => {
        if (active) setStatus('hidden');
      });
    return () => {
      active = false;
    };
  }, []);

  const loadPlaylists = useCallback(async (pageToken?: string) => {
    setLoadingList(true);
    setListError(null);
    try {
      const path = pageToken
        ? `/api/music/youtube/playlists?pageToken=${encodeURIComponent(pageToken)}`
        : '/api/music/youtube/playlists';
      const result = await apiFetch(path, {
        schema: YouTubePlaylistsResponseSchema,
        cache: 'no-store',
      });
      setPlaylists((previous) => {
        if (!pageToken) return result.playlists;
        const seen = new Set(previous.map((p) => p.id));
        return [...previous, ...result.playlists.filter((p) => !seen.has(p.id))];
      });
      setNextPageToken(result.nextPageToken);
      setLoaded(true);
    } catch (error) {
      if (needsReauth(error)) {
        setStatus('reauth');
        return;
      }
      setListError(
        errorMessage(error, 'Non è stato possibile leggere le tue playlist da YouTube. Riprova.'),
      );
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'connected' && open && !loaded && !loadingList) void loadPlaylists();
  }, [status, open, loaded, loadingList, loadPlaylists]);

  const limitReached = selected.length >= YOUTUBE_IMPORT_MAX_SOURCES;

  const toggle = (id: string, checked: boolean) => {
    if (!checked) {
      setSelected((previous) => previous.filter((value) => value !== id));
      return;
    }
    if (selected.includes(id) || limitReached) return;
    setSelected((previous) => [...previous, id]);
  };

  const runImport = async (event: FormEvent) => {
    event.preventDefault();
    if (importing || syncing || selected.length === 0) return;
    setImporting(true);
    try {
      const result = await apiFetch('/api/music/youtube/import', {
        method: 'POST',
        body: JSON.stringify({ playlistIds: selected } satisfies YouTubeAccountImportRequest),
        schema: YouTubeAccountImportResponseSchema,
      });
      const failedList = result.failed ?? [];
      const updatedList = result.updated ?? [];
      if (result.created.length || updatedList.length) {
        toast.success(changeSummary(result.created, updatedList));
        setSelected([]);
        onImported();
      }
      if (failedList.length) toast.error(failureSummary(failedList));
      if (failedList.some((item) => item.error === 'youtube_reauth')) setStatus('reauth');
    } catch (error) {
      if (needsReauth(error)) {
        setStatus('reauth');
        toast.error('La connessione con YouTube è scaduta: ricollega YouTube per importare.');
        return;
      }
      toast.error(errorMessage(error, 'Importazione da YouTube non riuscita. Riprova.'));
    } finally {
      setImporting(false);
    }
  };

  const runSync = async () => {
    if (importing || syncing) return;
    setSyncing(true);
    try {
      const result = await apiFetch('/api/music/youtube/sync', {
        method: 'POST',
        schema: YouTubeSyncResponseSchema,
      });
      const failedList = result.failed ?? [];
      const updatedList = result.updated ?? [];
      if (result.nothingToSync) {
        toast('Non hai ancora importato nulla da YouTube: scegli prima le playlist.');
      } else if (updatedList.length) {
        toast.success(syncSummary(updatedList));
        onImported();
      } else if (failedList.length === 0) {
        toast('Le tue playlist Solco sono già allineate a YouTube.');
      }
      if (failedList.length) toast.error(failureSummary(failedList));
      if (failedList.some((item) => item.error === 'youtube_reauth')) setStatus('reauth');
    } catch (error) {
      if (needsReauth(error)) {
        setStatus('reauth');
        toast.error('La connessione con YouTube è scaduta: ricollega YouTube per continuare.');
        return;
      }
      toast.error(errorMessage(error, 'Aggiornamento da YouTube non riuscito. Riprova.'));
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await apiFetch('/api/music/youtube/connection', {
        method: 'DELETE',
        schema: YouTubeConnectionStatusSchema,
      });
      setStatus('disconnected');
      setOpen(false);
      setPlaylists([]);
      setNextPageToken(null);
      setLoaded(false);
      setSelected([]);
      toast.success('YouTube scollegato.');
    } catch (error) {
      toast.error(errorMessage(error, 'Non è stato possibile scollegare YouTube. Riprova.'));
    } finally {
      setDisconnecting(false);
    }
  };

  if (status === 'loading' || status === 'hidden') return null;

  return (
    <section
      className="rounded-xl border border-border bg-card p-4 text-card-foreground"
      aria-labelledby={`${baseId}-title`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Youtube aria-hidden className="size-6 text-red-600" />
        <h2 id={`${baseId}-title`} className="font-display text-lg font-semibold">
          Connetti YouTube
        </h2>
      </div>

      {status === 'disconnected' ? (
        <>
          <p className="text-sm text-muted-foreground">
            Collega il tuo account YouTube e importa le tue playlist (anche private) in Solco.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Solco chiede a YouTube solo di leggere le tue playlist, non modifica nulla sul tuo
            account e salva soltanto i riferimenti dei video che scegli di importare.{' '}
            <Link href="/privacy" className="underline">
              Informativa privacy
            </Link>
          </p>
          <div className="mt-3">
            <Button asChild>
              <a href={CONNECT_PATH}>Accedi con YouTube</a>
            </Button>
          </div>
        </>
      ) : null}

      {status === 'reauth' ? (
        <>
          <p className="text-sm text-muted-foreground" role="alert">
            La connessione con YouTube è scaduta o è stata revocata. Ricollega YouTube per
            continuare: le playlist già importate restano nella tua Libreria.
          </p>
          <div className="mt-3">
            <Button asChild>
              <a href={CONNECT_PATH}>Ricollega YouTube</a>
            </Button>
          </div>
        </>
      ) : null}

      {status === 'connected' ? (
        <>
          <p className="text-sm text-muted-foreground">
            YouTube è collegato. Scegli fino a {YOUTUBE_IMPORT_MAX_SOURCES} delle tue playlist:
            Solco crea una playlist per ciascuna e riproduce i video on-demand.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant={open ? 'outline' : 'default'}
              aria-expanded={open}
              aria-controls={chooserId}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? 'Nascondi le playlist' : 'Scegli le playlist'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={importing || syncing}
              onClick={() => void runSync()}
              title="Risincronizza le playlist già importate con il tuo account YouTube"
            >
              {syncing ? 'Aggiornamento…' : 'Aggiorna da YouTube'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={disconnecting || importing || syncing}
              onClick={() => void disconnect()}
            >
              {disconnecting ? 'Scollegamento…' : 'Disconnetti YouTube'}
            </Button>
          </div>

          <form
            id={chooserId}
            hidden={!open}
            className="mt-4"
            aria-busy={importing || loadingList}
            onSubmit={(event) => void runImport(event)}
          >
            {listError ? (
              <div className="mb-3 rounded-lg border border-border p-3" role="alert">
                <p className="text-sm">{listError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  disabled={loadingList}
                  onClick={() => void loadPlaylists()}
                >
                  Riprova
                </Button>
              </div>
            ) : null}

            {loaded ? (
              <fieldset disabled={importing}>
                <legend className="mb-2 text-sm font-medium">
                  Le tue playlist ({selected.length}/{YOUTUBE_IMPORT_MAX_SOURCES} scelte)
                </legend>
                {playlists.length ? (
                  <ul className="flex flex-col gap-1">
                    {playlists.map((playlist) => {
                      const inputId = `${baseId}-playlist-${playlist.id}`;
                      const checked = selected.includes(playlist.id);
                      return (
                        <li
                          key={playlist.id}
                          className="flex items-center gap-3 rounded-lg p-2 hover:bg-muted/50"
                        >
                          <input
                            id={inputId}
                            type="checkbox"
                            className="size-4 shrink-0 accent-red-600"
                            checked={checked}
                            disabled={!checked && limitReached}
                            onChange={(event) => toggle(playlist.id, event.target.checked)}
                          />
                          <label
                            htmlFor={inputId}
                            className="flex min-w-0 flex-1 items-center gap-3"
                          >
                            {playlist.thumbnailUrl ? (
                              <Image
                                src={playlist.thumbnailUrl}
                                alt=""
                                width={52}
                                height={52}
                                unoptimized
                                className="size-13 shrink-0 rounded object-cover"
                              />
                            ) : (
                              <span
                                aria-hidden
                                className="flex size-13 shrink-0 items-center justify-center rounded bg-muted"
                              >
                                <ListMusic className="size-5 text-muted-foreground" />
                              </span>
                            )}
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate font-medium" title={playlist.title}>
                                {playlist.title}
                              </span>
                              {playlist.itemCount !== null ? (
                                <span className="text-xs text-muted-foreground">
                                  {videos(playlist.itemCount)}
                                </span>
                              ) : null}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Il tuo account YouTube non ha playlist da mostrare.
                  </p>
                )}

                {nextPageToken ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    disabled={loadingList}
                    onClick={() => void loadPlaylists(nextPageToken)}
                  >
                    {loadingList ? 'Caricamento…' : 'Carica altre playlist'}
                  </Button>
                ) : null}
              </fieldset>
            ) : loadingList ? (
              <p className="text-sm text-muted-foreground">Caricamento delle tue playlist…</p>
            ) : null}

            {loaded && playlists.length ? (
              <div className="mt-3 flex items-center gap-3">
                <Button type="submit" disabled={importing || syncing || selected.length === 0}>
                  {importing ? 'Importazione…' : 'Importa in Solco'}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {selected.length === 0
                    ? 'Nessuna selezione.'
                    : `Scelte ${selected.length} di ${YOUTUBE_IMPORT_MAX_SOURCES}.`}
                </span>
              </div>
            ) : null}
          </form>

          <footer className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
            <Youtube aria-hidden className="size-4" />
            Dati forniti da YouTube · puoi revocare l’accesso su{' '}
            <a
              href={GOOGLE_ACCOUNT_PERMISSIONS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              myaccount.google.com
            </a>
          </footer>
        </>
      ) : null}
    </section>
  );
}
