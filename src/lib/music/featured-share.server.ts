// @polsia:user-owned — id opaco del link «Condividi» di un brano in evidenza DICHIARATO:
// base64url(HMAC-SHA256(segreto del server, "featured-share:v1:" + pathname)), primi 22 caratteri.
// - Deterministico: lo stesso brano ha sempre lo stesso link (finché segreto e pathname restano).
// - Opaco: dal link non si risale al pathname del file nello store (né al suo stream).
// - Non falsificabile: senza il segreto non si calcola l'id di un brano, quindi un brano non
//   dichiarato non ha link (l'indice in featured-search.server mappa SOLO i dichiarati).
// Il segreto è BETTER_AUTH_SECRET (già obbligatorio per l'accesso), separato dagli altri usi dal
// prefisso "featured-share:v1:". Senza segreto la condivisione è spenta: nessun id, link 404.
// Cambiare il segreto (o rinominare il file) cambia i link: quelli già condivisi rispondono 404.
import 'server-only';
import { createHmac } from 'node:crypto';
import { FEATURED_SHARE_ID_LENGTH } from '@/lib/music/featured-share';

/** Contesto dell'HMAC: tiene questi id separati da ogni altro uso dello stesso segreto. */
export const FEATURED_SHARE_CONTEXT = 'featured-share:v1:';

/** Il segreto del server per gli id, o null (condivisione spenta) se manca o è vuoto. */
export function featuredShareSecret(): string | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret?.trim() ? secret : null;
}

/** L'id di condivisione di un pathname con il segreto dato (22 caratteri base64url). */
export function featuredShareId(pathname: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${FEATURED_SHARE_CONTEXT}${pathname}`)
    .digest('base64url')
    .slice(0, FEATURED_SHARE_ID_LENGTH);
}
