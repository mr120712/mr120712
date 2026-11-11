// @polsia:user-owned — scheda Libreria: playlist e cartelle, radio salvate, podcast seguiti, cronologia.
'use client';

import { FolderPlus, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useLibrary } from '@/components/custom/music/library-context';
import { savedStationToStation } from '@/components/custom/music/live-tracks';
import { MusicCollections } from '@/components/custom/music/music-collections';
import { PodcastTile } from '@/components/custom/music/podcast-tile';
import { StationTile } from '@/components/custom/music/radio-station-tile';
import { useHistoryPlayback } from '@/components/custom/music/recently-played-row';
import { TrackListImport } from '@/components/custom/music/track-list-import';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { YouTubePlaylistImportResponseSchema } from '@/lib/contracts/library';
import type { MusicCollection } from '@/lib/contracts/music';
import styles from './discover.module.css';

const tabs = [
  { id: 'playlist', label: 'Playlist' },
  { id: 'radio', label: 'Radio' },
  { id: 'podcast', label: 'Podcast' },
  { id: 'cronologia', label: 'Cronologia' },
] as const;
type TabId = (typeof tabs)[number]['id'];

function isTab(value: string | null): value is TabId {
  return tabs.some((tab) => tab.id === value);
}

function importError(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown })
      : null;
  return typeof cause?.message === 'string' ? cause.message : 'Importazione non riuscita.';
}

function PlaylistsTab() {
  const library = useLibrary();
  const { folders } = library.library;
  const [folderId, setFolderId] = useState<string | null | undefined>(undefined);
  const [folderName, setFolderName] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const activeFolder = folders.find((folder) => folder.id === folderId) ?? null;

  const createFolder = async (event: FormEvent) => {
    event.preventDefault();
    const name = folderName.trim();
    if (!name) return;
    if (await library.mutate({ action: 'create_folder', name }, 'Cartella creata.'))
      setFolderName('');
  };

  const renameFolder = async () => {
    if (!activeFolder) return;
    const name = window.prompt('Nuovo nome della cartella', activeFolder.name)?.trim();
    if (!name || name === activeFolder.name) return;
    await library.mutate(
      { action: 'rename_folder', folderId: activeFolder.id, name },
      'Cartella rinominata.',
    );
  };

  const deleteFolder = async () => {
    if (!activeFolder) return;
    if (
      !window.confirm(
        `Eliminare la cartella “${activeFolder.name}”? Le playlist restano nella Libreria.`,
      )
    )
      return;
    if (
      await library.mutate(
        { action: 'delete_folder', folderId: activeFolder.id },
        'Cartella eliminata.',
      )
    ) {
      setFolderId(undefined);
      setReloadKey((key) => key + 1);
    }
  };

  const importPlaylist = async (event: FormEvent) => {
    event.preventDefault();
    if (!importUrl.trim()) return;
    setImporting(true);
    try {
      const result = await apiFetch('/api/music/import/youtube-playlist', {
        method: 'POST',
        body: JSON.stringify({ url: importUrl.trim() }),
        schema: YouTubePlaylistImportResponseSchema,
      });
      toast.success(`“${result.name}” importata: ${result.imported} video.`);
      setImportUrl('');
      setReloadKey((key) => key + 1);
    } catch (error) {
      toast.error(importError(error));
    } finally {
      setImporting(false);
    }
  };

  const moveControl = (collection: MusicCollection) => (
    <>
      <label className="sr-only" htmlFor={`folder-${collection.id}`}>
        Cartella di {collection.name}
      </label>
      <select
        id={`folder-${collection.id}`}
        value={collection.folderId ?? ''}
        onChange={async (event) => {
          const target = event.target.value || null;
          if (
            await library.mutate(
              { action: 'move_playlist', collectionId: collection.id, folderId: target },
              target ? 'Playlist spostata nella cartella.' : 'Playlist spostata nella Libreria.',
            )
          )
            setReloadKey((key) => key + 1);
        }}
      >
        <option value="">Nessuna cartella</option>
        {folders.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.name}
          </option>
        ))}
      </select>
    </>
  );

  return (
    <div className={styles.section}>
      <fieldset className={styles.chips}>
        <legend className="sr-only">Cartelle</legend>
        <button
          type="button"
          aria-pressed={folderId === undefined}
          onClick={() => setFolderId(undefined)}
        >
          Tutte
        </button>
        <button type="button" aria-pressed={folderId === null} onClick={() => setFolderId(null)}>
          Senza cartella
        </button>
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            aria-pressed={folderId === folder.id}
            onClick={() => setFolderId(folder.id)}
          >
            {folder.name} · {folder.playlistIds.length}
          </button>
        ))}
      </fieldset>

      {activeFolder ? (
        <div className={styles.headerActions}>
          <Button type="button" variant="outline" size="sm" onClick={() => void renameFolder()}>
            <Pencil aria-hidden="true" /> Rinomina cartella
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void deleteFolder()}>
            <Trash2 aria-hidden="true" /> Elimina cartella
          </Button>
        </div>
      ) : null}

      <form className={styles.searchRow} onSubmit={(event) => void createFolder(event)}>
        <label className="sr-only" htmlFor="folder-name">
          Nome della nuova cartella
        </label>
        <input
          id="folder-name"
          value={folderName}
          maxLength={50}
          placeholder="Nuova cartella"
          onChange={(event) => setFolderName(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!folderName.trim()}>
          <FolderPlus aria-hidden="true" /> Crea cartella
        </Button>
      </form>

      <form className={styles.searchRow} onSubmit={(event) => void importPlaylist(event)}>
        <label className="sr-only" htmlFor="import-url">
          Link della playlist YouTube da importare
        </label>
        <input
          id="import-url"
          value={importUrl}
          maxLength={500}
          placeholder="Importa: incolla il link di una playlist YouTube"
          onChange={(event) => setImportUrl(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={importing || !importUrl.trim()}>
          {importing ? 'Importazione…' : 'Importa playlist'}
        </Button>
      </form>

      <TrackListImport onImported={() => setReloadKey((key) => key + 1)} />

      <MusicCollections
        embedded
        folderId={folderId}
        playlistActions={folders.length > 0 ? moveControl : undefined}
        reloadKey={reloadKey}
      />
    </div>
  );
}

function RadioTab() {
  const { library } = useLibrary();
  const stations = library.stations.map(savedStationToStation);
  if (stations.length === 0) {
    return (
      <p className={styles.state}>
        Nessuna radio salvata. <Link href="/radio">Scopri le radio</Link> e tocca il cuore per
        salvarle.
      </p>
    );
  }
  return (
    <div className={styles.grid}>
      {stations.map((station) => (
        <StationTile key={station.id} station={station} queue={stations} allowHide={false} />
      ))}
    </div>
  );
}

function PodcastTab() {
  const { library } = useLibrary();
  if (library.podcasts.length === 0) {
    return (
      <p className={styles.state}>
        Non segui ancora nessun podcast. <Link href="/podcasts">Esplora i podcast</Link>.
      </p>
    );
  }
  return (
    <div className={styles.grid}>
      {library.podcasts.map((podcast) => (
        <PodcastTile
          key={podcast.podcastId}
          allowHide={false}
          podcast={{
            id: podcast.podcastId,
            title: podcast.title,
            author: podcast.author,
            artworkUrl: podcast.artworkUrl,
            genre: null,
          }}
        />
      ))}
    </div>
  );
}

function HistoryTab() {
  const library = useLibrary();
  const playback = useHistoryPlayback();
  const [sort, setSort] = useState<'recent' | 'plays'>('recent');
  const history = [...library.library.history].sort((a, b) =>
    sort === 'plays'
      ? b.playCount - a.playCount || b.lastPlayedAt.localeCompare(a.lastPlayedAt)
      : b.lastPlayedAt.localeCompare(a.lastPlayedAt),
  );
  if (history.length === 0) {
    return (
      <p className={styles.state}>
        La cronologia è vuota: gli ascolti compaiono qui dopo 30 secondi.
      </p>
    );
  }
  return (
    <div className={styles.section}>
      <fieldset className={styles.chips}>
        <legend className="sr-only">Ordina cronologia</legend>
        <button type="button" aria-pressed={sort === 'recent'} onClick={() => setSort('recent')}>
          Più recenti
        </button>
        <button type="button" aria-pressed={sort === 'plays'} onClick={() => setSort('plays')}>
          Più ascoltati
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Cancellare tutta la cronologia di ascolto?'))
              void library.mutate({ action: 'clear_history' }, 'Cronologia cancellata.');
          }}
        >
          Cancella cronologia
        </button>
      </fieldset>
      <ol className={styles.list}>
        {history.map((entry) => {
          const playing = playback.isPlaying(entry);
          return (
            <li key={entry.qualifiedId} className={styles.row}>
              <div className={styles.rowArt}>
                <FallbackArt src={entry.artworkUrl} label={entry.title} size={104} />
              </div>
              <div className={styles.rowCopy}>
                <strong title={entry.title}>{entry.title}</strong>
                <span>
                  {entry.artistName} · {entry.sourceLabel} ·{' '}
                  {entry.playCount === 1 ? '1 ascolto' : `${entry.playCount} ascolti`}
                </span>
              </div>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={`${styles.iconButton} ${styles.playButton}`}
                  onClick={() => playback.play(entry, history)}
                  aria-label={
                    playing ? `Metti in pausa ${entry.title}` : `Riproduci ${entry.title}`
                  }
                >
                  {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function LibraryView() {
  const library = useLibrary();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = searchParams.get('tab');
  const active: TabId = isTab(requested) ? requested : 'playlist';

  return (
    <div className={styles.page}>
      <header>
        <h1 className={styles.pageTitle}>Libreria</h1>
        <p className={styles.lead}>Playlist, preferiti, radio, podcast e ascolti recenti.</p>
      </header>

      {!library.signedIn ? (
        <div className={styles.section}>
          <p className={styles.state}>
            Accedi per creare playlist, salvare radio e seguire podcast.
          </p>
          <div className={styles.headerActions}>
            <Button asChild>
              <Link href="/login">Accedi</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/signup">Registrati</Link>
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.chips} role="tablist" aria-label="Sezioni della Libreria">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active === tab.id}
                onClick={() =>
                  router.replace(tab.id === 'playlist' ? pathname : `${pathname}?tab=${tab.id}`, {
                    scroll: false,
                  })
                }
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {active === 'playlist' ? <PlaylistsTab /> : null}
            {active === 'radio' ? <RadioTab /> : null}
            {active === 'podcast' ? <PodcastTab /> : null}
            {active === 'cronologia' ? <HistoryTab /> : null}
          </div>
        </>
      )}
    </div>
  );
}
