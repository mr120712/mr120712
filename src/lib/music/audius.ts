// @polsia:user-owned
import {
  type AudiusAlbumSearchResult,
  AudiusAlbumSearchSchema,
  type AudiusArtistSearchResult,
  AudiusArtistSearchSchema,
  type AudiusPlaylistSearchResult,
  AudiusPlaylistSearchSchema,
  type AudiusTrackSearchResult,
  AudiusTrackSearchSchema,
} from '@/lib/contracts/music';

/** Add a licensor's Audius user ID here after receiving a removal request. */
export const AUDIUS_ATTRIBUTION_REMOVAL_USER_IDS: ReadonlySet<string> = new Set();

type RawRecord = Record<string, unknown>;

export type AudiusPlaybackReason =
  | 'ready'
  | 'not_streamable'
  | 'gated'
  | 'access_denied'
  | 'access_unknown'
  | 'license_not_allowed'
  | 'rate_limited'
  | 'state_unknown';

export type AudiusPlaybackEvaluation =
  | { allowed: true; reason: 'ready' }
  | { allowed: false; reason: Exclude<AudiusPlaybackReason, 'ready'> };

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultRows(payload: unknown): RawRecord[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data.filter(isRecord);
}

function resultRecordRows(payload: unknown): RawRecord[] {
  if (!isRecord(payload)) return [];
  const data = payload.data;
  if (Array.isArray(data)) return data.filter(isRecord);
  return isRecord(data) ? [data] : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeId(value: unknown): string | null {
  const id = stringValue(value);
  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function officialProfileUrl(handle: string | null): string | null {
  if (!handle) return null;
  return `https://audius.co/${encodeURIComponent(handle)}`;
}

export function officialTrackUrl(permalink: unknown): string | null {
  if (typeof permalink !== 'string' || !permalink.trim()) return null;
  try {
    const url = new URL(permalink, 'https://audius.co');
    if (url.protocol !== 'https:' || url.hostname !== 'audius.co') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function displayName(user: RawRecord): string | null {
  return stringValue(user.name) ?? stringValue(user.handle);
}

function copyrightNotice(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const year =
    typeof value.year === 'number' && Number.isInteger(value.year)
      ? String(value.year)
      : stringValue(value.year);
  const text = stringValue(value.text);
  if (!year || !/^\d{4}$/.test(year) || !text) return null;
  return `© ${year} ${text}`;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `/content/<cid>/<size>.jpg`, the image path used by every Audius content node. */
const AUDIUS_CONTENT_IMAGE_PATH =
  /^\/content\/[A-Za-z0-9]{20,128}\/(?:150x150|480x480|1000x1000)\.(?:jpg|jpeg|png|webp)$/i;

function artworkUrl(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const candidate =
    stringValue(value['480x480']) ??
    stringValue(value['150x150']) ??
    stringValue(value['1000x1000']);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const officialHost =
      host === 'audius.co' ||
      host.endsWith('.audius.co') ||
      host === 'audius.org' ||
      host.endsWith('.audius.org');
    // Artwork is served by the independent nodes of the Audius / Open Audio network (e.g.
    // *.staked.cloud, v.monophonic.digital), whose host names change over time: accept any
    // https node, but only with the protocol's own content path.
    const networkNode =
      AUDIUS_CONTENT_IMAGE_PATH.test(url.pathname) && !url.username && !url.password && !url.port;
    return url.protocol === 'https:' && (officialHost || networkNode) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * True when Solco may stream the track under the Audius Open Music License.
 * OML §1.1 covers all content on the Audius Protocol unless the artist picked an
 * "Alternative License" (§1.3). Audius leaves `license` empty (null) for the default, so:
 * - null, missing, empty or blank: the OML applies;
 * - a label that clearly names the Open Music License (or "OML"): the OML applies;
 * - anything else ("All rights reserved", any Creative Commons licence, CC BY included,
 *   unknown text or a non-string value): an alternative licence, not playable on Solco.
 */
export function isAudiusOpenMusicLicense(license: unknown): boolean {
  if (license === null || license === undefined) return true;
  if (typeof license !== 'string') return false;
  const label = license.trim();
  return label === '' || /open music license|\bOML\b/i.test(label);
}

export function evaluateAudiusPlayback(input: {
  sourceActive: boolean;
  isAvailable: unknown;
  isStreamable: unknown;
  /** The track's `license` field from Audius: only the Open Music License is playable. */
  license: unknown;
  trackIsStreamGated: unknown;
  accessCanStream: unknown;
  accessAuthorities: unknown;
}): AudiusPlaybackEvaluation {
  if (!input.sourceActive) return { allowed: false, reason: 'state_unknown' };
  if (input.isAvailable === false) return { allowed: false, reason: 'not_streamable' };
  if (input.isAvailable !== true) return { allowed: false, reason: 'state_unknown' };
  if (input.isStreamable === false) return { allowed: false, reason: 'not_streamable' };
  if (input.isStreamable !== true) return { allowed: false, reason: 'state_unknown' };
  // Before the access checks: with an alternative licence no Audius access makes it playable here.
  if (!isAudiusOpenMusicLicense(input.license)) {
    return { allowed: false, reason: 'license_not_allowed' };
  }
  if (typeof input.trackIsStreamGated !== 'boolean')
    return { allowed: false, reason: 'state_unknown' };
  if (input.accessCanStream === false) {
    return {
      allowed: false,
      reason: input.trackIsStreamGated ? 'gated' : 'access_denied',
    };
  }
  if (input.accessCanStream !== true) return { allowed: false, reason: 'access_unknown' };
  if (input.trackIsStreamGated) return { allowed: false, reason: 'gated' };
  // Audius sends access_authorities: null for tracks no external authority controls (every
  // open track today): an explicit null is an empty list. A missing field stays unknown.
  const authorities = input.accessAuthorities === null ? [] : input.accessAuthorities;
  if (!Array.isArray(authorities)) return { allowed: false, reason: 'access_unknown' };
  if (authorities.length > 0) return { allowed: false, reason: 'gated' };
  return { allowed: true, reason: 'ready' };
}

export function normalizeAudiusArtists(
  payload: unknown,
  attributionRemovalUserIds = AUDIUS_ATTRIBUTION_REMOVAL_USER_IDS,
): AudiusArtistSearchResult[] {
  return resultRows(payload).flatMap((record) => {
    const id = safeId(record.id);
    const handle = stringValue(record.handle);
    const name = displayName(record);
    const profileArtworkUrl =
      artworkUrl(record.profile_picture) ?? artworkUrl(record.profile_picture_sizes);
    if (!id || !handle || !name || !profileArtworkUrl || attributionRemovalUserIds.has(id))
      return [];
    const artist = {
      provider: 'audius' as const,
      id,
      qualifiedId: `audius:${id}`,
      name,
      handle,
      artworkUrl: profileArtworkUrl,
      profileUrl: officialProfileUrl(handle),
    };
    const parsed = AudiusArtistSearchSchema.safeParse(artist);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Distingue le playlist ordinarie dagli album Audius durante scoperta e ricerca. */
export function normalizeAudiusPlaylists(payload: unknown): AudiusPlaylistSearchResult[] {
  return resultRecordRows(payload).flatMap((record) => {
    if (record.is_album === true) return [];
    const id = safeId(record.id);
    const title = stringValue(record.playlist_name);
    const playlistUrl = officialTrackUrl(record.permalink);
    const user = isRecord(record.user) ? record.user : null;
    const handle = user ? stringValue(user.handle) : null;
    const artistName = user ? displayName(user) : null;
    const cover = artworkUrl(record.artwork) ?? artworkUrl(record.cover_art_sizes);
    if (!id || !title || !playlistUrl || !artistName || !handle || !cover) return [];

    const trackCount =
      typeof record.track_count === 'number' && Number.isSafeInteger(record.track_count)
        ? Math.max(0, record.track_count)
        : null;
    const playlist = {
      provider: 'audius' as const,
      id,
      qualifiedId: `audius:playlist:${id}`,
      title,
      artistName,
      artistUrl: officialProfileUrl(handle),
      playlistUrl,
      artworkUrl: cover,
      trackCount,
    };
    const parsed = AudiusPlaylistSearchSchema.safeParse(playlist);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Accepts only album records the Audius catalog explicitly marks as albums. */
export function normalizeAudiusAlbums(payload: unknown): AudiusAlbumSearchResult[] {
  return resultRecordRows(payload).flatMap((record) => {
    if (record.is_album !== true) return [];
    const id = safeId(record.id);
    const title = stringValue(record.playlist_name);
    const albumUrl = officialTrackUrl(record.permalink);
    const user = isRecord(record.user) ? record.user : null;
    const handle = user ? stringValue(user.handle) : null;
    const artistName = user ? displayName(user) : null;
    if (!id || !title || !albumUrl) return [];

    const trackCount =
      typeof record.track_count === 'number' && Number.isSafeInteger(record.track_count)
        ? Math.max(0, record.track_count)
        : null;
    const album = {
      provider: 'audius' as const,
      id,
      qualifiedId: `audius:album:${id}`,
      title,
      artistName,
      artistUrl: handle ? officialProfileUrl(handle) : null,
      albumUrl,
      artworkUrl: artworkUrl(record.artwork) ?? artworkUrl(record.cover_art_sizes),
      releaseDate: stringValue(record.release_date),
      trackCount,
    };
    const parsed = AudiusAlbumSearchSchema.safeParse(album);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Maps a detail response and its separately fetched catalog tracklist without inventing rows. */
export function mapAudiusAlbumDetail(
  albumPayload: unknown,
  tracksPayload: unknown,
  expectedAlbumId: string,
  sourceActive: boolean,
) {
  const album = normalizeAudiusAlbums(albumPayload).find((item) => item.id === expectedAlbumId);
  if (!album) return null;
  return {
    album,
    tracks: normalizeAudiusTracks(tracksPayload, sourceActive).map((track) => ({
      ...track,
      albumId: expectedAlbumId,
    })),
  };
}

export function normalizeAudiusTracks(
  payload: unknown,
  sourceActive = false,
  attributionRemovalUserIds = AUDIUS_ATTRIBUTION_REMOVAL_USER_IDS,
): AudiusTrackSearchResult[] {
  return resultRecordRows(payload).flatMap((record) => {
    const id = safeId(record.id);
    const title = stringValue(record.title);
    const trackUrl = officialTrackUrl(record.permalink);
    const user = isRecord(record.user) ? record.user : null;
    const artistId = user ? safeId(user.id) : null;
    const handle = user ? stringValue(user.handle) : null;
    const attributionRemovalRequested = artistId ? attributionRemovalUserIds.has(artistId) : false;
    const artistName = user && !attributionRemovalRequested ? displayName(user) : null;
    const licensorName = user && !attributionRemovalRequested ? displayName(user) : null;
    const coverUrl = artworkUrl(record.artwork) ?? artworkUrl(record.cover_art_sizes);
    if (
      !id ||
      !title ||
      !trackUrl ||
      !user ||
      !artistId ||
      !artistName ||
      !handle ||
      !coverUrl ||
      attributionRemovalRequested
    )
      return [];

    const rawAccess = isRecord(record.access) ? record.access : null;
    const license = stringValue(record.license);
    const copyright = copyrightNotice(record.copyright_line);
    const producerCopyright = copyrightNotice(record.producer_copyright_line);
    const attributionComplete = Boolean(licensorName && officialProfileUrl(handle) && trackUrl);
    const playback = evaluateAudiusPlayback({
      sourceActive,
      isAvailable: record.is_available,
      isStreamable: record.is_streamable,
      license: record.license,
      trackIsStreamGated: record.is_stream_gated,
      accessCanStream: rawAccess?.stream,
      accessAuthorities: record.access_authorities,
    });

    const track = {
      provider: 'audius' as const,
      id,
      qualifiedId: `audius:${id}`,
      title,
      artistName,
      artistHandle: attributionRemovalRequested ? null : handle,
      artistId,
      artistQualifiedId: `audius:${artistId}`,
      artistUrl: attributionRemovalRequested ? null : officialProfileUrl(handle),
      trackUrl,
      artworkUrl: coverUrl,
      durationSeconds:
        typeof record.duration === 'number' && Number.isSafeInteger(record.duration)
          ? Math.max(0, record.duration)
          : null,
      genre: stringValue(record.genre),
      mood: stringValue(record.mood),
      tags: stringValue(record.tags),
      releaseDate: stringValue(record.release_date),
      bpm: numberValue(record.bpm),
      musicalKey: stringValue(record.musical_key),
      isrc: stringValue(record.isrc),
      iswc: stringValue(record.iswc),
      license,
      licensorName,
      copyrightNotice: copyright,
      producerCopyrightNotice: producerCopyright,
      attributionRemovalRequested,
      attributionComplete,
      playbackEligible: playback.allowed,
      playbackReason: playback.reason,
    };
    const parsed = AudiusTrackSearchSchema.safeParse(track);
    return parsed.success ? [parsed.data] : [];
  });
}

export function getAudiusPlaybackReasonText(reason: AudiusPlaybackReason) {
  switch (reason) {
    case 'not_streamable':
      return 'Questo brano non è disponibile per lo streaming via API.';
    case 'gated':
      return 'Il brano richiede un accesso Audius che questa sessione non ha verificato.';
    case 'access_denied':
      return 'Audius non autorizza lo streaming per questo accesso.';
    case 'access_unknown':
      return 'Lo stato di accesso al flusso Audius non è verificabile.';
    case 'license_not_allowed':
      return "L'artista ha scelto una licenza diversa: questo brano si ascolta solo su Audius.";
    case 'rate_limited':
      return 'Audius ha limitato le richieste; attendi il tempo indicato prima di riprovare.';
    case 'state_unknown':
      return 'Stato del brano o della fonte non verificato: playback disattivato.';
    case 'ready':
      return 'Stream ufficiale Audius autorizzato.';
  }
}
