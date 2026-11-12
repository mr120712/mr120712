// @polsia:user-owned — playlist condivisa con un link pubblico (/playlist/<shareId>): lettura
// anonima e "salva una copia". Nessun dato privato: niente userId, email, id della raccolta o
// dei suoi elementi.
import { z } from 'zod';
import { MusicCollectionItemSchema } from '@/lib/contracts/music';
import { SHARE_ID_PATTERN, SHARED_PLAYLIST_OWNER_MAX_LENGTH } from '@/lib/music/playlist-share';

export const ShareIdSchema = z.string().regex(SHARE_ID_PATTERN);

/**
 * Solo i campi che servono al player e all'attribuzione; z.object scarta qualsiasi altro campo.
 * Niente id interno della riga: la pagina usa `source:sourceId`, unico nella playlist.
 */
export const SharedPlaylistItemSchema = MusicCollectionItemSchema.pick({
  source: true,
  sourceId: true,
  title: true,
  creatorName: true,
  artworkUrl: true,
  sourceUrl: true,
  artistUrl: true,
  durationSeconds: true,
});

export const SharedPlaylistSchema = z.object({
  name: z.string().min(1),
  /** Prima parola del nome dell'account (max 30 unità UTF-16) o un'etichetta generica. */
  owner: z.string().min(1).max(SHARED_PLAYLIST_OWNER_MAX_LENGTH),
  itemCount: z.number().int().nonnegative(),
  items: z.array(SharedPlaylistItemSchema),
  updatedAt: z.string().datetime(),
});

export const SaveSharedPlaylistResponseSchema = z.object({
  collectionId: z.string().min(1),
  name: z.string().min(1),
});

export type SharedPlaylist = z.infer<typeof SharedPlaylistSchema>;
export type SharedPlaylistItem = z.infer<typeof SharedPlaylistItemSchema>;
export type SaveSharedPlaylistResponse = z.infer<typeof SaveSharedPlaylistResponseSchema>;
