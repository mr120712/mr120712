// @polsia:user-owned — regole d'accesso allo stream dei "brani in evidenza" (route
// /api/music/home-tracks/stream), pure e testabili. L'audio si ascolta SOLO nel player di Solco, con
// un account:
// - niente hotlinking: una pagina di un altro sito che incorpora l'URL manda `Sec-Fetch-Site:
//   cross-site` (e il browser non allega nemmeno il cookie di sessione, SameSite=Lax) → rifiutata;
// - niente download diretto: aprire l'URL in una scheda è una navigazione (`Sec-Fetch-Dest:
//   document`) → rifiutata; l'elemento <audio> del player manda `Sec-Fetch-Dest: audio`;
// - il limite per account conta gli AVVII (richiesta senza Range o con un Range dall'inizio), non
//   ogni blocco: i seek e la riproduzione a blocchi di Safari non consumano il limite.
// I browser senza intestazioni Sec-Fetch (vecchi) passano questi controlli: resta la sessione.

/** Richiesta che avvia un ascolto: nessun Range, oppure un Range che parte dal primo byte. */
export function isFeaturedStreamStart(range: string | null | undefined): boolean {
  if (!range) return true;
  return /^\s*bytes\s*=\s*0\s*-/i.test(range);
}

const ALLOWED_SITES = new Set(['same-origin', 'same-site', 'none']);
const NAVIGATION_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

/**
 * True se la richiesta può venire dal player di Solco: stesso sito (o intestazioni assenti) e
 * destinazione non di navigazione. False per hotlinking da altri siti e per l'URL aperto in una
 * scheda o incorporato in una pagina.
 */
export function isFeaturedPlayerRequest(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (site && !ALLOWED_SITES.has(site)) return false;
  const dest = headers.get('sec-fetch-dest')?.trim().toLowerCase();
  if (dest && NAVIGATION_DESTS.has(dest)) return false;
  return true;
}
