// @polsia:user-owned — nota di licenza dei brani Audius (OML §1.5): avviso di copyright (quello di
// Audius o, se manca, "© <licenziante>"), rimando all'Audius Open Music License e, dove la riga non
// lo ha già, link al brano. Il copyright identifica l'artista: non viene mostrato se l'artista ha
// chiesto di rimuovere l'attribuzione.
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import {
  AUDIUS_OPEN_MUSIC_LICENSE_NAME,
  AUDIUS_OPEN_MUSIC_LICENSE_URL,
  audiusCopyrightText,
  isAudiusOpenMusicLicense,
} from '@/lib/music/audius';
import styles from './audius-license-notice.module.css';

export function AudiusLicenseNotice({
  track,
  showCopyright = true,
  showTrackLink = false,
}: {
  track: Pick<
    AudiusTrackSearchResult,
    | 'license'
    | 'copyrightNotice'
    | 'licensorName'
    | 'attributionRemovalRequested'
    | 'title'
    | 'trackUrl'
  >;
  /** false where the copyright line is already shown next to the attribution. */
  showCopyright?: boolean;
  /** true where the row has no other link to the track on Audius. */
  showTrackLink?: boolean;
}) {
  // Tracks under an alternative licence are not playable on Solco: their reason text says so.
  if (!isAudiusOpenMusicLicense(track.license)) return null;
  const copyright = showCopyright ? audiusCopyrightText(track) : null;
  return (
    <small className={styles.notice}>
      {copyright ? `${copyright} · ` : null}
      Licenza:{' '}
      <a href={AUDIUS_OPEN_MUSIC_LICENSE_URL} target="_blank" rel="noopener noreferrer">
        {AUDIUS_OPEN_MUSIC_LICENSE_NAME}
        <span className="sr-only"> (si apre in una nuova scheda)</span>
      </a>
      {showTrackLink ? (
        <>
          {' · '}
          <a href={track.trackUrl} target="_blank" rel="noopener noreferrer">
            Brano su Audius
            <span className="sr-only">: {track.title} (si apre in una nuova scheda)</span>
          </a>
        </>
      ) : null}
    </small>
  );
}
