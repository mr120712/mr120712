// @polsia:user-owned — pulsante compatto «Condividi» (solo icona) di un brano in evidenza: Home,
// ricerca globale e pagina d'artista. Compare SOLO se il server manda `shareId`, cioè per i brani
// con i diritti dichiarati in diritti.json: gli altri non hanno link, quindi nessun pulsante.
// Condivide il link diretto /evidenza/<shareId> (sito pubblico, mai il pathname del file) con la
// scheda JPEG come immagine. È un elemento a sé, fratello e MAI figlio del pulsante che suona il
// brano: un tocco qui apre il menu e non avvia la riproduzione. Nessuno stopPropagation: i
// contenitori della riga non hanno gestori, e fermare gli eventi qui (antenato React del menu in
// portale) impedirebbe a Radix di vedere i tocchi dentro il menu e di chiuderlo al tocco fuori.
'use client';

import { ShareMenu } from '@/components/custom/share-menu';
import { publicShareUrl } from '@/lib/business/social-share';
import {
  featuredShareImagePath,
  featuredSharePath,
  featuredShareText,
  featuredShareTitle,
} from '@/lib/music/featured-share';

export function FeaturedShareButton({
  track,
  className,
  buttonClassName,
}: {
  track: { title: string; artist: string | null; shareId?: string | null };
  /** Classi del contenitore (posizione nella riga o sulla copertina). */
  className?: string;
  /** Classi del pulsante (dimensioni, colori). */
  buttonClassName?: string;
}) {
  const { shareId } = track;
  if (!shareId) return null;
  const title = featuredShareTitle(track.title);
  return (
    <span className={className}>
      <ShareMenu
        size="icon"
        variant="ghost"
        align="end"
        className={buttonClassName}
        label="Condividi"
        ariaLabel={`Condividi ${track.title}`}
        title={title}
        text={featuredShareText(track.title, track.artist)}
        url={publicShareUrl(featuredSharePath(shareId))}
        imageUrl={featuredShareImagePath(shareId)}
      />
    </span>
  );
}
