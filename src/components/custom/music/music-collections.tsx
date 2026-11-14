// @polsia:user-owned
'use client';

import { Share2 } from 'lucide-react';
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
import { EmailVerification } from '@/components/custom/email-verification';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import {
  collectionQueue,
  isCollectionItemCurrent,
  playCollectionItem,
} from '@/components/custom/music/collection-tracks';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { collectionDownloadPlan } from '@/components/custom/music/offline-download';
import { OfflineDownloadButton } from '@/components/custom/music/offline-download-button';
import { ShareMenu } from '@/components/custom/share-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { apiErrorMessage } from '@/lib/business/api-error-message';
import { hasVerifiedContact } from '@/lib/business/phone-auth';
import { publicShareUrl } from '@/lib/business/social-share';
import {
  CollectionMutationResponseSchema,
  CollectionShareResponseSchema,
  type MusicCollection,
  type MusicCollectionItem,
  MusicCollectionsSchema,
} from '@/lib/contracts/music';
import {
  SHARED_PLAYLIST_OWNER_FALLBACK,
  sharedPlaylistOwnerName,
  sharedPlaylistPath,
} from '@/lib/music/playlist-share';
import styles from './music.module.css';

/**
 * Buttons that are busy keep their focus (aria-disabled, never disabled): a disabled button drops
 * the keyboard focus to <body>. Clicks are ignored while busy.
 */
const BUSY_BUTTON = 'aria-disabled:cursor-progress aria-disabled:opacity-60';

/** The error code the server sent (e.g. email_not_verified), if any. */
function serverErrorCode(error: unknown): string | null {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown })
      : null;
  return typeof cause?.error === 'string' ? cause.error : null;
}

function itemCount(count: number) {
  return count === 1 ? '1 elemento' : `${count} elementi`;
}

/** Exactly what the public page shows: «playlist» di <first word of the account name>. */
function PublicLabel({ name, owner }: { name: string; owner: string }) {
  return (
    <>
      «<bdi>{name}</bdi>» di{' '}
      <strong>
        <bdi>{owner}</bdi>
      </strong>
    </>
  );
}

/** Sharing, "Smetti di condividere" and "Elimina playlist" ask first. */
type ConfirmAction = {
  kind: 'share' | 'unshare' | 'delete';
  collection: MusicCollection;
  /** Takes the focus when the trigger is gone (after unsharing or deleting). */
  fallbackFocusId: string | null;
};

/** Public link of a shared playlist on the site the person is using. */
function shareLinkFor(shareId: string) {
  const path = sharedPlaylistPath(shareId);
  return typeof window === 'undefined' ? path : new URL(path, window.location.origin).toString();
}

/** Share sheet of the phone when there is one, otherwise the clipboard; a toast either way. */
async function deliverShareLink(title: string, url: string) {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url });
      toast.success('Playlist condivisa.');
      return;
    } catch (error) {
      // Closed by the person: nothing to say. Any other refusal falls back to the clipboard.
      if ((error as { name?: unknown } | null)?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Link copiato negli appunti.');
  } catch {
    toast('Link pronto: lo trovi sotto il nome della playlist.');
  }
}

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
  // While the player loads, the play buttons stay focusable and ignore clicks.
  const busyPlayProps = {
    'aria-disabled': isLoading || undefined,
    className: BUSY_BUTTON,
    onClick: () => {
      if (!isLoading) onPlay();
    },
  };

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
          <span>
            {item.source === 'youtube' ? 'YouTube' : item.source === 'song' ? 'Brano' : 'Audius'}
          </span>
        )}
      </div>
      <div className={styles.resultContent}>
        <div className={styles.resultHeading}>
          <div>
            <span
              className={`${styles.sourcePill} ${item.source === 'youtube' ? styles.youtubePill : ''}`}
            >
              {item.source === 'youtube'
                ? 'YouTube'
                : item.source === 'song'
                  ? 'Importato'
                  : 'Solco · Audius'}
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
                    : item.source === 'song'
                      ? 'Artista non indicato'
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

        {item.source === 'song' ? (
          <>
            <div className={styles.attribution}>
              <span>Brano importato · lo cerco su YouTube quando lo ascolti</span>
              {item.sourceUrl ? (
                <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                  Apri su Spotify
                </a>
              ) : null}
            </div>
            <Button type="button" variant="secondary" {...busyPlayProps}>
              {isCurrentTrack ? (isPlaying ? 'Pausa' : 'Riprendi') : 'Riproduci'}
            </Button>
          </>
        ) : item.source === 'audius' ? (
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
              {item.title && item.creatorName && item.sourceUrl ? (
                // OML §1.5: copyright ("© <artist>"), Open Music License link; the track link is
                // above. Only OML tracks can be saved (collections.server.ts) and the stream
                // re-checks the licence on every play.
                <AudiusLicenseNotice
                  track={{
                    license: null,
                    copyrightNotice: null,
                    licensorName: item.creatorName,
                    attributionRemovalRequested: false,
                    title: item.title,
                    trackUrl: item.sourceUrl,
                  }}
                />
              ) : null}
            </div>
            {item.title &&
            item.creatorName &&
            item.artworkUrl &&
            item.artistUrl &&
            item.sourceUrl ? (
              <Button type="button" variant="secondary" {...busyPlayProps}>
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
            <Button type="button" variant="secondary" {...busyPlayProps}>
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
  /** Playlist with a share, unshare or delete request in flight. */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Links returned by the server in this visit (the canonical site address). */
  const [shareUrls, setShareUrls] = useState<Record<string, string>>({});
  // Sharing publishes a public page: the server only allows it with a verified email or a phone
  // number confirmed by SMS.
  const { data: session } = useSession();
  const needsVerification = session?.user ? !hasVerifiedContact(session.user) : false;
  /** The label the public page shows for the owner, computed the same way as the server. */
  const ownerLabel = sharedPlaylistOwnerName(session?.user?.name);
  const idPrefix = useId();
  const shareButtonId = (collectionId: string) => `${idPrefix}-share-${collectionId}`;
  const headingId = (collectionId: string) => `${idPrefix}-heading-${collectionId}`;
  const verifyHintId = (collectionId: string) => `${idPrefix}-share-verify-${collectionId}`;
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmReturnFocus = useRef<HTMLElement | null>(null);
  /** After an action removes the focused block, the focus goes to this element id. */
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  /** The playlist whose "Condividi" needs a verified email first: the hint shows under it. */
  const [verifyHintFor, setVerifyHintFor] = useState<string | null>(null);
  const [verifyHintRequest, setVerifyHintRequest] = useState(0);
  const verifyHintRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!focusAfter || confirmOpen) return;
    setFocusAfter(null);
    const active = document.activeElement;
    // Only when the focus was lost with the removed block; never steal it from elsewhere.
    if (active && active !== document.body && active.isConnected) return;
    document.getElementById(focusAfter)?.focus();
  }, [focusAfter, confirmOpen]);

  // Each refused tap scrolls to the hint under that playlist and moves the focus there.
  useEffect(() => {
    if (verifyHintRequest > 0) verifyHintRef.current?.focus();
  }, [verifyHintRequest]);

  const visibleCollections =
    folderId === undefined
      ? collections
      : collections.filter(
          (collection) =>
            collection.kind === 'favorites' || (collection.folderId ?? null) === folderId,
        );
  const Wrapper = embedded ? 'div' : 'main';

  function askConfirm(
    kind: ConfirmAction['kind'],
    collection: MusicCollection,
    trigger: HTMLElement,
  ) {
    confirmReturnFocus.current = trigger;
    // A deleted playlist's section disappears: the focus goes to the heading next to it.
    const index = visibleCollections.findIndex((item) => item.id === collection.id);
    const neighbour = visibleCollections[index - 1] ?? visibleCollections[index + 1];
    setConfirm({
      kind,
      collection,
      fallbackFocusId:
        kind === 'delete'
          ? neighbour
            ? headingId(neighbour.id)
            : null
          : shareButtonId(collection.id),
    });
    setConfirmOpen(true);
  }

  function showVerifyHint(collectionId: string) {
    setVerifyHintFor(collectionId);
    setVerifyHintRequest((value) => value + 1);
    toast.error('Verifica prima la tua email.');
  }

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
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Playlist non creata. Usa un nome nuovo e riprova.'));
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

  async function deletePlaylist(collection: MusicCollection, fallbackFocusId: string | null) {
    setBusyId(collection.id);
    try {
      const response = await apiFetch('/api/music/collections', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete_playlist', collectionId: collection.id }),
        schema: CollectionMutationResponseSchema,
      });
      setCollections(response.collections);
      setShareUrls(({ [collection.id]: _removed, ...rest }) => rest);
      setFocusAfter(fallbackFocusId);
      toast.success(
        collection.shareId ? 'Playlist eliminata e link disattivato.' : 'Playlist eliminata.',
      );
    } catch {
      toast.error('Impossibile eliminare la playlist.');
    } finally {
      setBusyId(null);
    }
  }

  async function sharePlaylist(collection: MusicCollection) {
    if (collection.shareId) {
      // Already shared (the link never changes): open the share sheet inside the tap, with no
      // network wait that could cost the browser's user-gesture permission.
      await deliverShareLink(
        collection.name,
        shareUrls[collection.id] ?? shareLinkFor(collection.shareId),
      );
      return;
    }
    setBusyId(collection.id);
    let url: string;
    try {
      const response = await apiFetch('/api/music/collections', {
        method: 'POST',
        body: JSON.stringify({ action: 'share', collectionId: collection.id }),
        schema: CollectionShareResponseSchema,
      });
      setCollections(response.collections);
      setShareUrls((current) => ({ ...current, [collection.id]: response.url }));
      setVerifyHintFor((current) => (current === collection.id ? null : current));
      url = response.url;
    } catch (error) {
      if (serverErrorCode(error) === 'email_not_verified') showVerifyHint(collection.id);
      else toast.error(apiErrorMessage(error, 'Non è stato possibile creare il link. Riprova.'));
      return;
    } finally {
      setBusyId(null);
    }
    await deliverShareLink(collection.name, url);
  }

  async function unsharePlaylist(collectionId: string) {
    setBusyId(collectionId);
    try {
      const response = await apiFetch('/api/music/collections', {
        method: 'POST',
        body: JSON.stringify({ action: 'unshare', collectionId }),
        schema: CollectionMutationResponseSchema,
      });
      setCollections(response.collections);
      setShareUrls(({ [collectionId]: _removed, ...rest }) => rest);
      setFocusAfter(shareButtonId(collectionId));
      // The dialog already said what happens to the links sent and the copies saved by others.
      toast.success('Non condividi più la playlist.');
    } catch (error) {
      toast.error(
        apiErrorMessage(error, 'Non è stato possibile smettere di condividere. Riprova.'),
      );
    } finally {
      setBusyId(null);
    }
  }

  const target = confirm?.collection;
  const targetName = <bdi>{target?.name ?? 'questa playlist'}</bdi>;

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
            const queue = collectionQueue(collection.items);
            const shareUrl = collection.shareId
              ? (shareUrls[collection.id] ?? shareLinkFor(collection.shareId))
              : null;
            const busy = busyId === collection.id;
            const showVerifyHintHere = verifyHintFor === collection.id && Boolean(session?.user);

            return (
              <section key={collection.id} className={styles.collectionSection}>
                <div className={styles.resultsHeading}>
                  <div>
                    <h2 id={headingId(collection.id)} tabIndex={-1}>
                      {collection.name}
                    </h2>
                    <span>
                      {collection.kind === 'favorites' ? 'Preferiti' : 'Playlist'} ·{' '}
                      {itemCount(collection.items.length)}
                    </span>
                  </div>
                  {collection.kind === 'playlist' ? (
                    <div className={styles.playlistActions}>
                      {playlistActions?.(collection)}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        id={shareButtonId(collection.id)}
                        aria-label={`Condividi la playlist ${collection.name}`}
                        aria-describedby={
                          showVerifyHintHere ? verifyHintId(collection.id) : undefined
                        }
                        aria-disabled={busy || undefined}
                        className={BUSY_BUTTON}
                        onClick={(event) => {
                          if (busy) return;
                          // Already shared: the share sheet opens inside the tap. Unverified email:
                          // nothing can be published yet, the hint says why. Otherwise the person
                          // first sees exactly what the public page will show.
                          if (collection.shareId) void sharePlaylist(collection);
                          else if (needsVerification) showVerifyHint(collection.id);
                          else askConfirm('share', collection, event.currentTarget);
                        }}
                      >
                        <Share2 aria-hidden="true" /> Condividi
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Elimina la playlist ${collection.name}`}
                        aria-haspopup="dialog"
                        aria-disabled={busy || undefined}
                        className={BUSY_BUTTON}
                        onClick={(event) => {
                          if (!busy) askConfirm('delete', collection, event.currentTarget);
                        }}
                      >
                        Elimina playlist
                      </Button>
                    </div>
                  ) : null}
                </div>
                {showVerifyHintHere && session?.user ? (
                  <div
                    ref={verifyHintRef}
                    id={verifyHintId(collection.id)}
                    tabIndex={-1}
                    className={styles.shareVerify}
                  >
                    <p>
                      <strong>
                        Per condividere una playlist con un link serve un indirizzo email
                        verificato.
                      </strong>{' '}
                      Così le pagine pubbliche di Solco arrivano solo da account confermati.
                    </p>
                    <EmailVerification email={session.user.email} callbackURL="/library" />
                  </div>
                ) : null}
                {collection.kind === 'playlist' && shareUrl ? (
                  <div className={styles.shareLink}>
                    <p>
                      Condivisa con un link: chi lo apre vede{' '}
                      <PublicLabel name={collection.name} owner={ownerLabel} /> e i brani, e può
                      salvarne una copia.
                    </p>
                    <a href={shareUrl} target="_blank" rel="noreferrer">
                      {shareUrl}
                    </a>
                    <ShareMenu
                      size="sm"
                      variant="secondary"
                      label="Condividi sui social"
                      ariaLabel={`Condividi sui social la playlist ${collection.name}`}
                      title={collection.name}
                      text={`Ascolta la playlist “${collection.name}” su Solco.`}
                      url={
                        collection.shareId
                          ? publicShareUrl(sharedPlaylistPath(collection.shareId))
                          : shareUrl
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Smetti di condividere la playlist ${collection.name}`}
                      aria-haspopup="dialog"
                      aria-disabled={busy || undefined}
                      className={BUSY_BUTTON}
                      onClick={(event) => {
                        if (!busy) askConfirm('unshare', collection, event.currentTarget);
                      }}
                    >
                      Smetti di condividere
                    </Button>
                  </div>
                ) : null}
                {collection.items.length ? (
                  <OfflineDownloadButton
                    label={collection.name}
                    plan={collectionDownloadPlan(collection.items)}
                    signedIn={Boolean(session?.user)}
                  />
                ) : null}
                {collection.items.length ? (
                  <div className={styles.collectionItems}>
                    {collection.items.map((item) => (
                      <CollectionItem
                        key={item.id}
                        collectionId={collection.id}
                        item={item}
                        onPlay={() => playCollectionItem(player, item, queue)}
                        isCurrentTrack={isCollectionItemCurrent(player, item)}
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

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // No trigger element: send the focus back by hand, or to the fallback if the trigger
            // is already gone. Never steal it from where a finished action already moved it.
            event.preventDefault();
            const active = document.activeElement;
            if (active && active !== document.body && active.isConnected) return;
            const back = confirmReturnFocus.current;
            if (back?.isConnected) back.focus();
            else if (confirm?.fallbackFocusId)
              document.getElementById(confirm.fallbackFocusId)?.focus();
          }}
        >
          {confirm?.kind === 'share' ? (
            <AlertDialogHeader>
              <AlertDialogTitle>Condividere “{targetName}” con un link?</AlertDialogTitle>
              <AlertDialogDescription>
                Chi apre il link vedrà{' '}
                <PublicLabel name={target?.name ?? 'questa playlist'} owner={ownerLabel} /> e i
                brani, e potrà salvarne una copia.{' '}
                {ownerLabel === SHARED_PLAYLIST_OWNER_FALLBACK ? null : (
                  <>
                    «<bdi>{ownerLabel}</bdi>» è la prima parola del nome del tuo account.{' '}
                  </>
                )}
                La tua email non compare mai, la pagina non finisce sui motori di ricerca e puoi
                smettere di condividere quando vuoi.
              </AlertDialogDescription>
            </AlertDialogHeader>
          ) : confirm?.kind === 'delete' ? (
            <AlertDialogHeader>
              <AlertDialogTitle>Eliminare “{targetName}”?</AlertDialogTitle>
              <AlertDialogDescription>
                La playlist sparisce dalla tua Libreria e non si può recuperare; i brani restano
                nelle altre raccolte che li contengono.
                {target?.shareId
                  ? ' Ogni link a questa playlist che hai già inviato smetterà di funzionare (può volerci qualche minuto). Le copie già salvate da altri restano nelle loro Librerie.'
                  : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
            <AlertDialogHeader>
              <AlertDialogTitle>Smettere di condividere “{targetName}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Ogni link a questa playlist che hai già inviato smetterà di funzionare (può volerci
                qualche minuto). Se la condividi di nuovo, Solco creerà un link nuovo. Le copie già
                salvate da altri restano nelle loro Librerie.
              </AlertDialogDescription>
            </AlertDialogHeader>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              className={
                confirm?.kind === 'share' ? undefined : buttonVariants({ variant: 'destructive' })
              }
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === 'share') void sharePlaylist(confirm.collection);
                else if (confirm.kind === 'unshare') void unsharePlaylist(confirm.collection.id);
                else void deletePlaylist(confirm.collection, confirm.fallbackFocusId);
              }}
            >
              {confirm?.kind === 'share'
                ? 'Crea il link'
                : confirm?.kind === 'delete'
                  ? 'Elimina playlist'
                  : 'Smetti di condividere'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Wrapper>
  );
}
