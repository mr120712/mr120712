// @polsia:user-owned — interruttore del catalogo Jamendo: spento finché manca una licenza commerciale.

/**
 * Jamendo resta SPENTO finché il titolare non ha un accordo commerciale scritto con Jamendo.
 *
 * Perché: i termini della API gratuita Jamendo (devportal.jamendo.com) ne consentono l'uso solo
 * per scopi non commerciali, e Solco ha piani a pagamento. Per l'uso commerciale serve una
 * licenza Jamendo: scrivere a licensing@jamendo.com.
 *
 * Il catalogo si accende solo con ENTRAMBE le variabili server-side:
 * - JAMENDO_CLIENT_ID: la chiave dell'app sul portale sviluppatori Jamendo;
 * - JAMENDO_COMMERCIAL_LICENSE=confirmed: da impostare solo dopo aver firmato l'accordo.
 *
 * Da spento ogni route Jamendo risponde "not_configured", la sezione Jamendo non mostra nulla e
 * nessun testo di Solco (piani, ricerca, termini) presenta Jamendo come vantaggio.
 */
export const JAMENDO_COMMERCIAL_LICENSE_CONFIRMED = 'confirmed';

export function jamendoEnabled(env: Record<string, string | undefined> = process.env) {
  return (
    Boolean(env.JAMENDO_CLIENT_ID?.trim()) &&
    env.JAMENDO_COMMERCIAL_LICENSE?.trim() === JAMENDO_COMMERCIAL_LICENSE_CONFIRMED
  );
}
