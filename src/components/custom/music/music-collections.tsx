// @polsia:user-owned
'use client';

import Image from 'next/image';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  CollectionMutationResponseSchema,
  type MusicCollection,
  type MusicCollectionItem,
  MusicCollectionsSchema,
} from '@/lib/contracts/music';
import { videoToTrack } from './live-tracks';
import styles from './music.module.css';

function CollectionItem({
  collectionId,
  item,
  onPlay,
  isCurrentTrack,
  isPlaying,
  isLoading,
  onRemove,
}: {
  collectionId: string;
  item: MusicCollectionItem;
  onPlay: () => void;
  isCurrentTrack: boolean;
  isPlaying: boolean;
  isLoading: boolean;
  onRemove: (collectionId: string, itemId: string) => void;
}) {
  const expired = item.source === 'youtube' && !item.title;

  return (
    <article
      className={`${styles.resultCard} ${item.source === 'youtube' ? styles.youtubeCard : ''} ${item.source === 'youtube' && isCurrentTrack ? styles.youtubeCardPlaying : ''}`}
    >
      <div
        className={`${styles.artwork} ${item.source === 'youtube' ? styles.youtubeArtwork : ''}`}
      >
        {item.artworkUrl ? (
          <Image
            src={item.artworkUrl}
            alt={`Copertina di ${item.title ?? 'video salvato'}`}
            width={96}
            height={96}
            unoptimized
          />
        ) : (
          <span>{item.source === 'youtube' ? 'YouTube' : 'Audius'}</span>
        )}
      </div>
      <div className={styles.resultContent}>
        <div className={styles.resultHeading}>
          <div>
            <span
              className={`${styles.sourcePill} ${item.source === 'youtube' ? styles.youtubePill : ''}`}
            >
              {item.source === 'youtube' ? 'YouTube' : 'Solco · Audius'}
            </span>
            <h3>
              {item.title ??
                (item.source === 'youtube'
                  ? 'Video YouTube salvato'
                  : 'Metadati del brano non disponibili')}
            </h3>
            <p className={styles.artistLine}>
              {item.creatorName ??
                (expired
                  ? 'Metadati rimossi dopo la scadenza; il video resta nelle raccolte.'
                  : item.source === 'audius'
                    ? 'Audius non ha confermato i metadati completi di questo brano.'
                    : 'Canale YouTube non disponibile.')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onRemove(collectionId, item.id)}
          >
            Rimuovi
          </Button>
        </div>

        {item.source === 'audius' ? (
          <>
            <div className={styles.attribution}>
              <span>Fonte: Audius</span>
              {item.artistUrl ? (
                <a href={item.artistUrl} target="_blank" rel="noreferrer">
                  Profilo artista Audius
                </a>
              ) : null}
              {item.sourceUrl ? (
                <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                  Brano su Audius
                </a>
              ) : null}
            </div>
            {item.title &&
            item.creatorName &&
            item.artworkUrl &&
            item.artistUrl &&
            item.sourceUrl ? (
              <Button type="button" variant="secondary" onClick={onPlay} disabled={isLoading}>
                {isCurrentTrack ? (isPlaying ? 'Pausa' : 'Riprendi') : 'Riproduci su Solco'}
              </Button>
            ) : (
              <p className={styles.playbackBlocked}>
                Audius non ha confermato metadati completi; il brano non viene avviato.
              </p>
            )}
          </>
        ) : (
          <>
            <div className={styles.attribution}>
              <span>
                Metadati da YouTube Data API v3
                {item.expiresAt
                  ? ` · aggiornamento entro ${new Date(item.expiresAt).toLocaleDateString('it-IT')}`
                  : ''}
              </span>
              {item.sourceUrl ? (
                <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                  Video su YouTube
                </a>
              ) : null}
            </div>
            <Button type="button" variant="secondary" onClick={onPlay} disabled={isLoading}>
              {isCurrentTrack ? (isPlaying ? 'Pausa' : 'Riprendi') : 'Riproduci'}
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

type MusicCollectionsProps = {
  /** Inside the Library tab: no page heading, no <main> landmark. */
  embedded?: boolean;
  /** Show only playlists in this folder (null = root, undefined = all). Favourites always show. */
  folderId?: string | null;
  /** Extra controls next to each playlist heading (e.g. "move to folder"). */
  playlistActions?: (collection: MusicCollection) => ReactNode;
  /** Change it to re-fetch (e.g. after importing a playlist). */
  reloadKey?: number;
};

export function MusicCollections({
  embedded = false,
  folderId,
  playlistActions,
  reloadKey = 0,
}: MusicCollectionsProps = {}) {
  const player = useMusicPlayer();
  const [collections, setCollections] = useState<MusicCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/api/music/collections', { schema: MusicCollectionsSchema });
      setCollections(response.collections);
      setMessage(null);
    } catch {
      setMessage('Non è stato possibile caricare le raccolte di questo account.');
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an explicit refetch trigger.
  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const visibleCollections =
    folderId === undefined
      ? collections
      : collections.filter(
          (collection) =>
            collection.kind === 'favorites' || (collection.folderId ?? null) === folderId,
        );
  const Wrapper = embedded ? 'div' : 'main';

  async function createPlaylist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const response = await apiFetch('/api/music/collections', {
        method: 'POST',
        body: JSON.stringify({ action: 'create_playlist', name }),
        schema: CollectionMutationResponseSchema,
      });
      setCollections(response.collections);
      setName('');
      toast.success('Playlist creata.');
    } catch {
      toast.error('Playlist non creata. Usa un nome nuovo e riprova.');
    }
  }

  async function removeItem(collectionId: string, itemId: string) {
    try {
      const response = await apiFetch('/api/music/collections', {
        method: 'POST',
        body: JSON.stringify({ action: 'remove_item', collectionId, itemId }),
        schema: CollectionMutationResponseSchema,
      });
      setCollections(response.collections);
      toast.success('Elemento rimosso.');
    } catch {
      toast.error('Impossibile rimuovere questo elemento.');
    }
  }

  async function deletePlaylist(collectionId: string) {
    try {
      const response = await apiFetch('/api/music/collections', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete_playlist', collectionId }),
        schema: CollectionMutationResponseSchema,
      });
      setCollections(response.collections);
      toast.success('Playlist eliminata.');
    } catch {
      toast.error('Impossibile eliminare la playlist.');
    }
  }

  return (
    <Wrapper className={embedded ? undefined : styles.page}>
      {embedded ? null : (
        <>
          <div className={styles.topline}>
            <p className={styles.eyebrow}>SOLCO · IL TUO SPAZIO</p>
            <Link href="/search">Cerca musica</Link>
          </div>
          <h1 className={styles.title}>Preferiti e playlist.</h1>
          <p className={styles.lead}>
            Le raccolte sono private per account e possono includere brani Audius e video YouTube. I
            video si aprono solo nel player ufficiale visibile.
          </p>
        </>
      )}

      <form className={styles.createPlaylist} onSubmit={(event) => void createPlaylist(event)}>
        <label htmlFor="playlist-name">Crea una playlist</label>
        <div>
          <input
            id="playlist-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={50}
            placeholder="Nome playlist"
            required
          />
          <Button type="submit" disabled={!name.trim()}>
            Crea playlist
          </Button>
        </div>
      </form>

      {loading ? <p className={styles.stateMessage}>Caricamento delle raccolte…</p> : null}
      {message ? (
        <p className={styles.stateMessage} role="alert">
          {message}
        </p>
      ) : null}
      {!loading && !message
        ? visibleCollections.map((collection) => {
            const queue: MusicPlayerTrack[] = collection.items.flatMap((item) => {
              if (item.source === 'youtube') {
                return item.title && /^[A-Za-z0-9_-]{11}$/.test(item.sourceId)
                  ? [
                      videoToTrack({
                        videoId: item.sourceId,
                        title: item.title,
                        channelTitle: item.creatorName ?? 'YouTube',
                        thumbnailUrl: item.artworkUrl,
                      }),
                    ]
                  : [];
              }
              if (
                item.source !== 'audius' ||
                !/^[A-Za-z0-9_-]{1,128}$/.test(item.sourceId) ||
                !item.title ||
                !item.creatorName ||
                !item.artworkUrl ||
                !item.artistUrl ||
                !item.sourceUrl
              ) {
                return [];
              }
              return [
                {
                  qualifiedId: `audius:${item.sourceId}`,
                  title: item.title,
                  artistName: item.creatorName,
                  artistUrl: item.artistUrl,
                  artworkUrl: item.artworkUrl,
                  sourceLabel: 'Solco · Audius',
                  sourceUrl: item.sourceUrl,
                  sourceUrlLabel: 'Apri il brano su Audius',
                  durationSeconds: item.durationSeconds,
                  playbackMode: 'audius',
                },
              ];
            });

            return (
              <section key={collection.id} className={styles.collectionSection}>
                <div className={styles.resultsHeading}>
                  <div>
                    <h2>{collection.name}</h2>
                    <span>
                      {collection.kind === 'favorites' ? 'Preferiti' : 'Playlist'} ·{' '}
                      {collection.items.length} elementi
                    </span>
                  </div>
                  {collection.kind === 'playlist' ? (
                    <div className={styles.playlistActions}>
                      {playlistActions?.(collection)}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void deletePlaylist(collection.id)}
                      >
                        Elimina playlist
                      </Button>
                    </div>
                  ) : null}
                </div>
                {collection.items.length ? (
                  <div className={styles.collectionItems}>
                    {collection.items.map((item) => (
                      <CollectionItem
                        key={item.id}
                        collectionId={collection.id}
                        item={item}
                        onPlay={() => {
                          const qualifiedId = `${item.source}:${item.sourceId}`;
                          const current = queue.find((track) => track.qualifiedId === qualifiedId);
                          if (!current) return;
                          if (player.currentTrack?.qualifiedId === current.qualifiedId) {
                            void player.togglePlayback();
                            return;
                          }
                          const path = trackStreamPath(current);
                          if (path) void player.playTrack(current, path, queue);
                        }}
                        isCurrentTrack={
                          player.currentTrack?.qualifiedId === `${item.source}:${item.sourceId}`
                        }
                        isPlaying={player.status === 'playing'}
                        isLoading={player.status === 'loading'}
                        onRemove={removeItem}
                      />
                    ))}
                  </div>
                ) : (
                  <p className={styles.emptyCollection}>
                    La raccolta è vuota. Cerca un brano e tocca il cuore per aggiungerlo.
                  </p>
                )}
              </section>
            );
          })
        : null}
    </Wrapper>
  );
}
