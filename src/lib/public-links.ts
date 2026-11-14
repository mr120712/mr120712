// @polsia:user-owned — dominio pubblico canonico di Solco per i link che si CONDIVIDONO (inviti).
//
// Un invito deve portare sempre al sito ufficiale, qualunque sia il dominio da cui l'utente lo ha
// copiato (anteprime, *.vercel.app, localhost) e qualunque sia l'host usato dal bot per webhook e
// Mini App. Si usa www.solcomusic.online direttamente: il dominio nudo solcomusic.online risponde
// con un redirect 308 verso www, e così il link arriva senza salti.
//
// Sovrascrivibile con NEXT_PUBLIC_INVITE_BASE_URL (solo https, senza credenziali); un valore non
// valido viene ignorato. Modulo condiviso: niente import server-only, lo usa anche il client.

const DEFAULT_PUBLIC_SITE_URL = 'https://www.solcomusic.online';

/** Origine pubblica per i link condivisi (es. https://www.solcomusic.online), senza slash finale. */
export function publicSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_INVITE_BASE_URL?.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.origin;
    } catch {
      // Valore non valido: si usa il dominio ufficiale.
    }
  }
  return DEFAULT_PUBLIC_SITE_URL;
}

/** Link d'invito per un codice: <sito pubblico>/invito/<codice>. */
export function inviteUrlForCode(code: string): string {
  return `${publicSiteUrl()}/invito/${encodeURIComponent(code)}`;
}

/** Pagina premi sul sito pubblico (pulsante «I tuoi premi» del bot). */
export function publicRewardsUrl(): string {
  return `${publicSiteUrl()}/premi`;
}
