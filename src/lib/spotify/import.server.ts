// @polsia:user-owned — lettura dal vivo delle playlist Spotify e trasferimento dei loro METADATI
// (titolo, artisti, durata, link al brano) in playlist di Solco. Consentito dalla Spotify Developer
// Policy: "transfer … the metadata of the user's playlists to another service". L'elenco delle
// playlist non viene mai salvato; si salva solo ciò che l'utente sceglie di importare.
//
// Campi verificati sullo schema OpenAPI ufficiale (solo campi e endpoint non deprecati):
// - GET /me/playlists (limit ≤ 50, offset) → PagingPlaylistObject { total, items: SimplifiedPlaylistObject
//   { id, name, owner{id,display_name}, images[{url,width,height}], items.total,
//   external_urls.spotify } } (`tracks` è deprecato: si usa `items.total`). `items` manca nelle
//   playlist di cui l'utente non è proprietario né collaboratore (guida alla migrazione di feb. 2026):
//   per quelle /playlists/{id}/items risponde 403.
// - GET /playlists/{playlist_id}?fields=name → PlaylistObject.name
// - GET /playlists/{playlist_id}/items (limit ≤ 50, offset, fields) → PagingPlaylistTrackObject
//   { total, items: PlaylistTrackObject { is_local, item: TrackObject | EpisodeObject } } (`track`
//   è deprecato; /playlists/{id}/tracks è deprecato).
// - GET /me/tracks (limit ≤ 50, offset) → PagingSavedTrackObject { total, items: SavedTrackObject
//   { track: TrackObject } } (/me/library non ha un GET: questo è l'endpoint di lettura).
// - TrackObject { type, id, name, duration_ms, is_local, external_urls.spotify, artists[].name }.
import 'server-only';
import { z } from 'zod';
import {
  type ImportedTrack,
  songIdentity,
  TRACK_LIST_MAX_TRACKS,
} from '@/lib/business/track-list-import';
import { createSongPlaylist } from '@/lib/business/track-list-import.server';
import type {
  SpotifyImportResponse,
  SpotifyPlaylist,
  SpotifyPlaylistsResponse,
} from '@/lib/contracts/spotify';
import { SPOTIFY_PLAYLISTS_PAGE_SIZE } from '@/lib/contracts/spotify';
import {
  describeSpotifyError,
  type SpotifyAuth,
  SpotifyError,
  type SpotifyFetchOptions,
  spotifyFetch,
} from '@/lib/spotify/client.server';

/** Largest page Spotify allows for /playlists/{id}/items and /me/tracks (OpenAPI: maximum 50). */
export const SPOTIFY_PAGE_LIMIT = 50;
/** Items read per source at most: enough for 200 tracks after skipping local files and doubles. */
export const SPOTIFY_MAX_PAGES = Math.ceil(TRACK_LIST_MAX_TRACKS / SPOTIFY_PAGE_LIMIT) + 2;
/** Highest offset accepted by GET /me/playlists (OpenAPI: "Maximum offset: 100.000"). */
export const SPOTIFY_MAX_PLAYLIST_OFFSET = 100_000;
export const SAVED_TRACKS_PLAYLIST_NAME = 'Brani salvati su Spotify';
const FALLBACK_PLAYLIST_NAME = 'Playlist Spotify';
const MAX_COLLECTION_NAME = 50;
const MAX_FIELD = 200;
const MAX_DISPLAY_TEXT = 500;
const MAX_DURATION_SECONDS = 24 * 3600 - 1;
const MIN_IMAGE_SIZE = 64;
/** Only the fields the import needs (`fields` parameter of GET /playlists/{id}/items). */
const PLAYLIST_ITEM_FIELDS =
  'total,items(is_local,item(type,id,name,duration_ms,is_local,external_urls.spotify,artists(name)))';

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

// ---------------------------------------------------------------------------------------------
// Text helpers: Spotify metadata is shown as provided, minus control characters.

function withoutControl(value: string) {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    const loneSurrogate = code >= 0xd800 && code <= 0xdfff;
    if (!control && !loneSurrogate) out += char;
  }
  return out;
}

/** Cleans a field for storage: no control characters, single spaces, at most `max` code points. */
function cleanField(value: unknown, max = MAX_FIELD): string {
  if (typeof value !== 'string') return '';
  const text = withoutControl(value.slice(0, 2_000)).replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, max).join('').trim();
}

function displayText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = Array.from(withoutControl(value.slice(0, 2_000)))
    .slice(0, MAX_DISPLAY_TEXT)
    .join('');
  return text.trim() ? text : null;
}

// ---------------------------------------------------------------------------------------------
// Playlist list (GET /me/playlists + total of GET /me/tracks), fetched live and never stored.

const NullableString = z.string().nullish();
const ImageSchema = z.object({
  url: z.string(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});
const SimplifiedPlaylistSchema = z.object({
  id: z.string().regex(SPOTIFY_ID),
  name: NullableString,
  owner: z.object({ id: NullableString, display_name: NullableString }).nullish(),
  images: z.array(ImageSchema.nullable()).nullish(),
  items: z.object({ total: z.number().int().nonnegative().nullish() }).nullish(),
  external_urls: z.object({ spotify: NullableString }).nullish(),
});
type SimplifiedPlaylist = z.infer<typeof SimplifiedPlaylistSchema>;
const PagingSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(z.unknown()).nullish(),
});
/** owner.id of Spotify's own editorial and algorithmic playlists. */
const SPOTIFY_OWNER_ID = 'spotify';

function httpsUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Smallest cover that is at least 64 px wide; an image without size if none; else null. */
export function pickImage(
  images: ReadonlyArray<{ url: string; width?: number | null; height?: number | null } | null>,
): string | null {
  const valid = images.flatMap((image) => {
    const url = image ? httpsUrl(image.url) : null;
    return image && url ? [{ url, size: image.width ?? image.height ?? null }] : [];
  });
  const sized = valid
    .filter((image) => image.size !== null && image.size >= MIN_IMAGE_SIZE)
    .sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
  return sized[0]?.url ?? valid.find((image) => image.size === null)?.url ?? null;
}

function openSpotifyUrl(value: string | null | undefined, kind: 'playlist' | 'track', id: string) {
  const url = httpsUrl(value);
  if (url && new URL(url).hostname === 'open.spotify.com') return url;
  return `https://open.spotify.com/${kind}/${id}`;
}

/**
 * Whether Spotify lets this app read the playlist's items. GET /playlists/{id}/items answers 403
 * unless the listener owns the playlist or is one of its collaborators, and Spotify returns the
 * `items` field only for exactly those playlists: for one the listener merely follows, `items` is
 * absent (docs: February 2026 migration guide, Get Playlist Items). So the presence of `items` is
 * the signal, whoever the owner is. The `collaborative` attribute is not: it says anyone with the
 * link may edit, which is different from having collaborators. Spotify's own editorial playlists
 * (owner.id "spotify") are never readable. A playlist with `items` but no known owner stays
 * importable; if Spotify still refuses it, the import reports spotify_forbidden for that source.
 */
function isImportable(playlist: SimplifiedPlaylist): boolean {
  if (playlist.owner?.id === SPOTIFY_OWNER_ID) return false;
  return playlist.items != null;
}

/** A SimplifiedPlaylistObject → SpotifyPlaylist. */
export function mapPlaylist(raw: unknown): SpotifyPlaylist | null {
  const parsed = SimplifiedPlaylistSchema.safeParse(raw);
  if (!parsed.success) return null;
  const playlist = parsed.data;
  return {
    id: playlist.id,
    name: displayText(playlist.name) ?? '',
    owner: displayText(playlist.owner?.display_name),
    imageUrl: pickImage(playlist.images ?? []),
    itemCount: playlist.items?.total ?? null,
    spotifyUrl: openSpotifyUrl(playlist.external_urls?.spotify, 'playlist', playlist.id),
    importable: isImportable(playlist),
  };
}

function invalidResponse() {
  return new SpotifyError({ status: 502, reason: 'invalid_response' });
}

export async function listSpotifyPlaylists(
  auth: SpotifyAuth,
  offset: number,
  options: SpotifyFetchOptions = {},
): Promise<SpotifyPlaylistsResponse> {
  const limit = SPOTIFY_PLAYLISTS_PAGE_SIZE;
  const [playlistsRaw, savedRaw] = await Promise.all([
    spotifyFetch(`/me/playlists?limit=${limit}&offset=${offset}`, auth, options),
    spotifyFetch('/me/tracks?limit=1', auth, options),
  ]);
  const playlists = PagingSchema.safeParse(playlistsRaw);
  const saved = PagingSchema.safeParse(savedRaw);
  if (!playlists.success || !saved.success) throw invalidResponse();
  const mapped = (playlists.data.items ?? [])
    .slice(0, limit)
    .map(mapPlaylist)
    .filter((playlist): playlist is SpotifyPlaylist => playlist !== null);
  const next = offset + limit;
  return {
    playlists: mapped,
    savedTracks: saved.data.total,
    nextOffset: next < playlists.data.total && next <= SPOTIFY_MAX_PLAYLIST_OFFSET ? next : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Track mapping (pure).

const TrackSchema = z.object({
  type: NullableString,
  id: NullableString,
  name: NullableString,
  duration_ms: z.number().nullish(),
  is_local: z.boolean().nullish(),
  external_urls: z.object({ spotify: NullableString }).nullish(),
  artists: z.array(z.object({ name: NullableString }).nullable()).nullish(),
});

function trackUrl(id: string | null | undefined, external: string | null | undefined) {
  if (id && SPOTIFY_ID.test(id)) return `https://open.spotify.com/track/${id}`;
  const match =
    /^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})(?:[?#]|$)/.exec(
      external ?? '',
    );
  return match ? `https://open.spotify.com/track/${match[1]}` : null;
}

/**
 * A Spotify TrackObject → ImportedTrack, or null for local files, episodes, other future item
 * types and items without a title.
 */
export function mapSpotifyTrack(raw: unknown, wrapperIsLocal = false): ImportedTrack | null {
  if (wrapperIsLocal || raw === null || raw === undefined) return null;
  const parsed = TrackSchema.safeParse(raw);
  if (!parsed.success) return null;
  const track = parsed.data;
  if (track.type !== 'track' || track.is_local) return null;
  const title = cleanField(track.name);
  if (!title) return null;
  const artist = (track.artists ?? [])
    .map((entry) => cleanField(entry?.name))
    .filter(Boolean)
    .join(', ');
  const duration =
    typeof track.duration_ms === 'number' && Number.isFinite(track.duration_ms)
      ? Math.round(track.duration_ms / 1000)
      : null;
  return {
    title,
    artist: Array.from(artist).slice(0, MAX_FIELD).join('').trim() || null,
    durationSeconds:
      duration !== null && duration > 0 && duration <= MAX_DURATION_SECONDS ? duration : null,
    sourceUrl: trackUrl(track.id, track.external_urls?.spotify),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading one source: pages of 50, at most SPOTIFY_MAX_PAGES, 200 unique tracks.

export type CollectedTracks = { tracks: ImportedTrack[]; skipped: number; truncated: number };

const PlaylistItemSchema = z.object({ is_local: z.boolean().nullish(), item: z.unknown() });
const SavedTrackSchema = z.object({ track: z.unknown() });

async function collectPages(
  pathFor: (offset: number) => string,
  pick: (raw: unknown) => { track: unknown; isLocal: boolean } | null,
  auth: SpotifyAuth,
  options: SpotifyFetchOptions,
): Promise<CollectedTracks> {
  const tracks: ImportedTrack[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let truncated = 0;
  let read = 0;
  let total = 0;
  for (let page = 0; page < SPOTIFY_MAX_PAGES; page += 1) {
    const offset = page * SPOTIFY_PAGE_LIMIT;
    const parsed = PagingSchema.safeParse(await spotifyFetch(pathFor(offset), auth, options));
    if (!parsed.success) throw invalidResponse();
    total = parsed.data.total;
    const items = (parsed.data.items ?? []).slice(0, SPOTIFY_PAGE_LIMIT);
    for (const raw of items) {
      read += 1;
      const picked = pick(raw);
      const track = picked ? mapSpotifyTrack(picked.track, picked.isLocal) : null;
      if (!track) {
        skipped += 1;
        continue;
      }
      const identity = songIdentity(track.title, track.artist);
      if (seen.has(identity)) {
        skipped += 1;
        continue;
      }
      seen.add(identity);
      if (tracks.length >= TRACK_LIST_MAX_TRACKS) {
        truncated += 1;
        continue;
      }
      tracks.push(track);
    }
    const done =
      items.length < SPOTIFY_PAGE_LIMIT ||
      offset + SPOTIFY_PAGE_LIMIT >= total ||
      tracks.length >= TRACK_LIST_MAX_TRACKS;
    if (done) break;
  }
  // Items past the pages read count as beyond the limit.
  truncated += Math.max(0, total - read);
  return { tracks, skipped, truncated };
}

export function collectPlaylistTracks(
  playlistId: string,
  auth: SpotifyAuth,
  options: SpotifyFetchOptions = {},
): Promise<CollectedTracks> {
  const fields = encodeURIComponent(PLAYLIST_ITEM_FIELDS);
  return collectPages(
    (offset) =>
      `/playlists/${playlistId}/items?limit=${SPOTIFY_PAGE_LIMIT}&offset=${offset}&fields=${fields}`,
    (raw) => {
      const parsed = PlaylistItemSchema.safeParse(raw);
      return parsed.success ? { track: parsed.data.item, isLocal: !!parsed.data.is_local } : null;
    },
    auth,
    options,
  );
}

export function collectSavedTracks(
  auth: SpotifyAuth,
  options: SpotifyFetchOptions = {},
): Promise<CollectedTracks> {
  return collectPages(
    (offset) => `/me/tracks?limit=${SPOTIFY_PAGE_LIMIT}&offset=${offset}`,
    (raw) => {
      const parsed = SavedTrackSchema.safeParse(raw);
      return parsed.success ? { track: parsed.data.track, isLocal: false } : null;
    },
    auth,
    options,
  );
}

const PlaylistNameSchema = z.object({ name: NullableString });

async function playlistName(
  playlistId: string,
  auth: SpotifyAuth,
  options: SpotifyFetchOptions,
): Promise<string> {
  const parsed = PlaylistNameSchema.safeParse(
    await spotifyFetch(`/playlists/${playlistId}?fields=name`, auth, options),
  );
  if (!parsed.success) throw invalidResponse();
  return cleanField(parsed.data.name, MAX_COLLECTION_NAME) || FALLBACK_PLAYLIST_NAME;
}

// ---------------------------------------------------------------------------------------------
// The transfer.

export type SpotifyImportSource = { kind: 'playlist'; id: string } | { kind: 'saved' };

type Created = SpotifyImportResponse['created'][number];
type Failed = SpotifyImportResponse['failed'][number];

const sourceKey = (source: SpotifyImportSource) =>
  source.kind === 'saved' ? ('saved' as const) : source.id;

/** Per-source problems that do not stop the other sources. */
function isSourceError(error: unknown) {
  return (
    error instanceof SpotifyError && (error.reason === 'forbidden' || error.reason === 'not_found')
  );
}

/**
 * Imports each source (in order) as a new Solco playlist of songs resolved lazily on play.
 * A per-source refusal (playlist not owned, deleted) is reported in `failed`; any other error
 * stops the import: thrown when nothing was created yet, otherwise reported for the remaining
 * sources so the playlists already created are not hidden.
 */
export async function runSpotifyImport(
  userId: string,
  sources: SpotifyImportSource[],
  auth: SpotifyAuth,
  options: SpotifyFetchOptions = {},
): Promise<SpotifyImportResponse> {
  const created: Created[] = [];
  const failed: Failed[] = [];
  for (const [index, source] of sources.entries()) {
    try {
      const name =
        source.kind === 'saved'
          ? SAVED_TRACKS_PLAYLIST_NAME
          : await playlistName(source.id, auth, options);
      const collected =
        source.kind === 'saved'
          ? await collectSavedTracks(auth, options)
          : await collectPlaylistTracks(source.id, auth, options);
      if (collected.tracks.length === 0) {
        failed.push({
          source: sourceKey(source),
          error: 'empty',
          message: `“${name}” non contiene brani importabili (file locali e podcast sono esclusi).`,
        });
        continue;
      }
      const playlist = await createSongPlaylist(userId, name, collected.tracks);
      created.push({
        collectionId: playlist.collectionId,
        name: playlist.name,
        imported: collected.tracks.length,
        skipped: collected.skipped,
        truncated: collected.truncated,
        source: sourceKey(source),
      });
    } catch (error) {
      if (isSourceError(error)) {
        const description = describeSpotifyError(error);
        failed.push({
          source: sourceKey(source),
          error: description.error,
          message: description.message,
        });
        continue;
      }
      if (created.length === 0) throw error;
      const description = describeSpotifyError(error);
      for (const remaining of sources.slice(index)) {
        failed.push({
          source: sourceKey(remaining),
          error: description.error,
          message: description.message,
        });
      }
      break;
    }
  }
  return { created, failed };
}
