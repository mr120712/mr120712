// @polsia:user-owned — interruttori delle funzioni di Solco, in un solo posto. Nessun import lato
// server: lo leggono sia le pagine e i componenti client sia le route handler. Ogni controllo
// chiama la FUNZIONE (non la costante), così i test possono simulare entrambi gli stati con
// vi.mock('@/lib/features', …).

/**
 * Libreria pubblica dei brani caricati dagli utenti (/pubblica, «Brani più ascoltati dalla
 * community ❤️»). Libreria pubblica disattivata su richiesta; per riattivarla metti true.
 *
 * Da spenta: /pubblica rimanda alla Home (307 HTTP da next.user-config.ts, più il redirect della
 * pagina come riserva), niente voce nel menu (né nella sitemap e in llms.txt), niente sezione in
 * Home, le API della libreria rispondono 404 e il player non chiede il testo dei brani caricati.
 * Restano all'autore l'elenco privato, il download e la rimozione dei PROPRI brani (pannello «I tuoi
 * brani caricati» su /scarica): i dati (righe nel database, file su Vercel Blob) e i modelli Prisma
 * non si toccano.
 */
const PUBLIC_UPLOADS_ENABLED = false;

/** true se la libreria pubblica dei brani caricati dagli utenti è attiva. */
export function publicUploadsEnabled(): boolean {
  return PUBLIC_UPLOADS_ENABLED;
}
