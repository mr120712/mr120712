// @polsia:user-owned — condivisione sui social da parte degli utenti: semplici link alle pagine di
// condivisione dei servizi (nessun SDK, nessuno script di terzi, nessun dato inviato da Solco).
// Chi tocca il link apre WhatsApp, Telegram, X, Facebook o l'email con testo e link già pronti.
import { isShareableCoverUrl } from '@/lib/music/shareable-cover';
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

/** Lunghezze massime di titolo e artista nel link e nell'anteprima. */
const SHARED_TITLE_MAX = 120;
const SHARED_ARTIST_MAX = 80;

/**
 * Link per condividere un brano: la ricerca di Solco con artista e titolo (funziona per ogni fonte;
 * chi non ha ancora un account passa dall'accesso e torna qui). Porta anche titolo e artista per
 * l'anteprima social e, se è una copertina condivisibile (Audius, vedi shareable-cover), la sua
 * immagine: WhatsApp, Telegram, X e Facebook mostrano così la scheda con la copertina.
 */
export function songShareUrl(
  title: string,
  artist: string | null,
  base = publicSiteUrl(),
  cover?: string | null,
): string {
  const query = tidy(`${artist ?? ''} ${title}`, 80);
  const params = [`q=${strictEncode(query)}`, `t=${strictEncode(tidy(title, SHARED_TITLE_MAX))}`];
  if (artist?.trim()) params.push(`a=${strictEncode(tidy(artist, SHARED_ARTIST_MAX))}`);
  if (isShareableCoverUrl(cover)) params.push(`img=${strictEncode(cover)}`);
  return publicShareUrl(`/search?${params.join('&')}`, base);
}

export type SharedSongCard = { title: string; artist: string | null; cover: string | null };

function firstParam(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : '';
}

/**
 * Il brano di un link condiviso (parametri t, a, img; q se manca il titolo), per l'anteprima
 * social. null se il link non descrive un brano. La copertina passa solo se condivisibile.
 */
export function sharedSongFromParams(
  params: Record<string, string | string[] | undefined>,
): SharedSongCard | null {
  const title = tidy(firstParam(params.t) || firstParam(params.q), SHARED_TITLE_MAX);
  if (!title) return null;
  const artist = tidy(firstParam(params.a), SHARED_ARTIST_MAX) || null;
  const cover = firstParam(params.img);
  return { title, artist, cover: isShareableCoverUrl(cover) ? cover : null };
}

/** Percorso dell'immagine di anteprima (PNG 1200×630) di un brano condiviso. */
export function songPreviewImagePath(song: SharedSongCard): string {
  const params = [`t=${strictEncode(song.title)}`];
  if (song.artist) params.push(`a=${strictEncode(song.artist)}`);
  if (song.cover) params.push(`img=${strictEncode(song.cover)}`);
  return `/search/anteprima.png?${params.join('&')}`;
}

/** Testo per condividere ciò che si sta ascoltando. */
export function songShareText(title: string, artist: string | null, live = false): string {
  const name = tidy(title, 120);
  const by = artist ? ` di ${tidy(artist, 80)}` : '';
  return live ? `Sto ascoltando ${name} su Solco.` : `Sto ascoltando «${name}»${by} su Solco.`;
}
