// @polsia:user-owned — quali brani del player possono avere il TESTO (pannello "Testo" stile
// Spotify) e dove chiederlo. SOLO tre casi, dove Solco ha il diritto di mostrarlo:
// - brano in evidenza (qualifiedId "upload:<pathname dello store>", es. "upload:Pop/A - B.mp3"):
//   il server lo mostra solo se diritti.json dichiara "testo": true per quel file;
// - upload di un utente (qualifiedId "upload:<id>", id cuid): solo se pubblicato e con il testo
//   confermato dall'autore, e solo con la libreria pubblica attiva (src/lib/features.ts);
// - file dell'ascoltatore in "La tua musica" (qualifiedId "local:<id>", fonte "La tua musica"):
//   letto sul dispositivo, mai inviato. I brani SCARICATI (Audius, podcast) restano esclusi, e
//   così le copie offline dei brani in evidenza (registro featured-offline-copies): il loro testo
//   si mostra solo dal server, con "testo": true in diritti.json, mai dai tag del file.
// Mai per Audius, YouTube, brani importati, radio, podcast, Jamendo o anteprime.
import { featuredCopyFor } from '@/components/custom/music/featured-offline-copies';
import type { MusicPlayerTrack } from '@/components/custom/music/music-player';
import { publicUploadsEnabled } from '@/lib/features';
import { LOCAL_SOURCE_LABEL, localTrackId } from './local-tracks';

export type LyricsTarget =
  | { source: 'featured'; id: string }
  | { source: 'upload'; id: string }
  | { source: 'local'; id: string };

/** Id di un upload pubblico (cuid), come nel contratto della libreria. */
const UPLOAD_ID = /^[a-z0-9]{20,40}$/;
/** Estensioni audio dei brani in evidenza (le stesse del server, home-tracks.server). */
const FEATURED_AUDIO = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm|weba)$/i;

/** Pathname plausibile di un brano in evidenza (il server lo rivalida comunque). */
function isFeaturedPathname(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith('/') &&
    !value.startsWith('public-uploads/') &&
    !value.includes('\\') &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    FEATURED_AUDIO.test(value)
  );
}

/** Dove chiedere il testo del brano, o null se per questo brano non si mostra mai. */
export function lyricsTargetFor(
  track: Pick<
    MusicPlayerTrack,
    'qualifiedId' | 'playbackMode' | 'sourceLabel' | 'sourceUrl'
  > | null,
): LyricsTarget | null {
  if (!track) return null;
  if (track.playbackMode === 'local') {
    const id = localTrackId(track.qualifiedId);
    // Solo i file dell'ascoltatore: i download (Audius, podcast) hanno un'altra fonte e un link;
    // una copia di un brano in evidenza non è mai un file dell'ascoltatore (nemmeno se il brano del
    // player è stato costruito senza la sua attribuzione).
    if (!id || track.sourceLabel !== LOCAL_SOURCE_LABEL || track.sourceUrl) return null;
    if (featuredCopyFor(id)) return null;
    return { source: 'local', id };
  }
  if (track.playbackMode !== 'upload' || !track.qualifiedId.startsWith('upload:')) return null;
  const rest = track.qualifiedId.slice('upload:'.length);
  // Un upload rimasto in coda o nel player con la libreria spenta: niente pannello "Testo".
  if (UPLOAD_ID.test(rest)) return publicUploadsEnabled() ? { source: 'upload', id: rest } : null;
  if (isFeaturedPathname(rest)) return { source: 'featured', id: rest };
  return null;
}
