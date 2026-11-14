// @polsia:user-owned — condivisione sui social da parte degli utenti: semplici link alle pagine di
// condivisione dei servizi (nessun SDK, nessuno script di terzi, nessun dato inviato da Solco).
// Chi tocca il link apre WhatsApp, Telegram, X, Facebook o l'email con testo e link già pronti.
import { publicSiteUrl } from '@/lib/public-links';

export type SocialShareTarget = {
  id: 'whatsapp' | 'telegram' | 'x' | 'facebook' | 'email';
  label: string;
  href: string;
};

/**
 * encodeURIComponent lascia ! ' ( ) * ~: qui diventano %XX, così il link è accettato anche come
 * destinazione dopo l'accesso (better-auth rifiuta questi caratteri, es. "Help!" o "P!nk").
 */
function strictEncode(value: string) {
  return encodeURIComponent(value.replace(LONE_SURROGATE, '\uFFFD')).replace(
    /[!'()*~]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Metà di emoji rimaste sole (dati sporchi): encodeURIComponent le rifiuterebbe con un errore. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Spazi compattati e lunghezza limitata (il testo finisce in un URL). Il taglio è per caratteri
 * interi: tagliare a metà un'emoji lascerebbe un surrogato solo e la codifica fallirebbe.
 */
function tidy(value: string, max: number) {
  const clean = value.replace(LONE_SURROGATE, '\uFFFD').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, max).join('').trim();
}

/** Link di condivisione per i social principali (Instagram e TikTok passano dal menu del telefono). */
export function socialShareLinks(input: {
  url: string;
  text: string;
  title?: string;
}): SocialShareTarget[] {
  const url = input.url.replace(LONE_SURROGATE, '\uFFFD').trim();
  const text = tidy(input.text, 280);
  const subject = tidy(input.title ?? 'Solco', 120);
  const enc = encodeURIComponent;
  return [
    { id: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${enc(`${text} ${url}`)}` },
    {
      id: 'telegram',
      label: 'Telegram',
      href: `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`,
    },
    { id: 'x', label: 'X', href: `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}` },
    {
      id: 'facebook',
      label: 'Facebook',
      href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    },
    {
      id: 'email',
      label: 'Email',
      href: `mailto:?subject=${enc(subject)}&body=${enc(`${text}\n\n${url}`)}`,
    },
  ];
}

/** Indirizzo pubblico (sito ufficiale) per un percorso di Solco, es. "/generi/rock". */
export function publicShareUrl(path: string, base = publicSiteUrl()): string {
  return new URL(path, `${base}/`).toString();
}

/**
 * Link per condividere un brano: la ricerca di Solco con artista e titolo. Funziona per ogni fonte
 * (la ricerca è unica); chi non ha ancora un account passa dall'accesso e torna qui.
 */
export function songShareUrl(title: string, artist: string | null, base = publicSiteUrl()): string {
  const query = tidy(`${artist ?? ''} ${title}`, 80);
  return publicShareUrl(`/search?q=${strictEncode(query)}`, base);
}

/** Testo per condividere ciò che si sta ascoltando. */
export function songShareText(title: string, artist: string | null, live = false): string {
  const name = tidy(title, 120);
  const by = artist ? ` di ${tidy(artist, 80)}` : '';
  return live ? `Sto ascoltando ${name} su Solco.` : `Sto ascoltando «${name}»${by} su Solco.`;
}
