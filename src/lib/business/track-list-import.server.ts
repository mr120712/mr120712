// @polsia:user-owned — identificativo stabile di un brano importato (artista + titolo).
import 'server-only';
import { createHash } from 'node:crypto';
import { songIdentity } from '@/lib/business/track-list-import';

/** Same artist + title → same id, whatever the spelling, accents or punctuation. */
export function songSourceId(title: string, artist: string | null) {
  return createHash('sha256').update(songIdentity(title, artist)).digest('hex').slice(0, 32);
}
