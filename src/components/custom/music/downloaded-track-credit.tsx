// @polsia:user-owned — attribuzione di un brano SCARICATO ("Scarica il permesso") nella Libreria e, se
// serve, nel player. Per un brano Audius mostra copyright, la Audius Open Music License (OML §1.5) e il
// link al brano; per un episodio podcast mostra lo show e il credito. Per i file locali non compare
// nulla (nessuna attribuzione). I link si aprono in una nuova scheda, in modo sicuro.
import type { LocalTrackAttribution, LocalTrackSource } from '@/lib/local-music';
import styles from './downloaded-track-credit.module.css';

/** Testo accanto al link al brano/episodio, in base alla fonte. */
function sourceLinkLabel(source: LocalTrackSource): string {
  return source === 'audius-download' ? 'Brano su Audius' : 'Episodio originale';
}

export function DownloadedTrackCredit({
  source,
  attribution,
  title,
}: {
  source: LocalTrackSource;
  attribution: LocalTrackAttribution | null;
  /** Titolo del brano, solo per l'etichetta accessibile del link. */
  title?: string;
}) {
  // I file locali non portano crediti.
  if (source === 'local' || !attribution) return null;
  const { sourceName, sourceUrl, licenseName, licenseUrl, creditLine } = attribution;
  const hasLicense = Boolean(licenseName);
  const hasSourceLink = Boolean(sourceUrl);
  // Senza niente da mostrare non si rende una riga vuota.
  if (!creditLine && !sourceName && !hasLicense && !hasSourceLink) return null;

  return (
    <small className={styles.credit}>
      {creditLine ? (
        <span>{creditLine}</span>
      ) : sourceName ? (
        <span>Fonte: {sourceName}</span>
      ) : null}
      {hasLicense ? (
        <>
          <span aria-hidden="true"> · </span>
          <span>
            Licenza:{' '}
            {licenseUrl ? (
              <a href={licenseUrl} target="_blank" rel="noopener noreferrer">
                {licenseName}
                <span className="sr-only"> (si apre in una nuova scheda)</span>
              </a>
            ) : (
              licenseName
            )}
          </span>
        </>
      ) : null}
      {hasSourceLink && sourceUrl ? (
        <>
          <span aria-hidden="true"> · </span>
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
            {sourceLinkLabel(source)}
            <span className="sr-only">
              {title ? `: ${title} ` : ' '}(si apre in una nuova scheda)
            </span>
          </a>
        </>
      ) : null}
    </small>
  );
}
