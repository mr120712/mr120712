// @polsia:user-owned — quali copertine possono finire nell'anteprima social di una playlist
// condivisa. Modulo puro: lo usa il server (sharedPlaylistCovers) prima di scaricarle per disegnare
// l'anteprima; gli URL arrivano dai metadati Audius verificati salvati nella Libreria. Un brano
// condiviso non passa di qui: la sua copertina la legge il server da Audius (audius-share-card),
// mai da un URL del link. Solo copertine Audius: mai miniature YouTube, perché le piattaforme
// social conservano l'immagine dell'anteprima senza scadenza, mentre i dati della YouTube API si
// tengono meno di 30 giorni.

/** `/content/<cid>/<size>.<ext>`: il percorso delle copertine sui nodi della rete Audius. */
const AUDIUS_CONTENT_IMAGE_PATH =
  /^\/content\/[A-Za-z0-9]{20,128}\/(?:150x150|480x480|1000x1000)\.(?:jpg|jpeg|png|webp)$/i;

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isHost(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Copertina Audius che l'anteprima social può scaricare: solo https, sempre con il percorso delle
 * copertine dei nodi Audius (anche sui domini audius.co / audius.org), senza query né frammento,
 * mai IP, porte o credenziali. Le miniature YouTube (i.ytimg.com) sono escluse.
 */
export function isShareableCoverUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if (url.search || url.hash || value.includes('?') || value.includes('#')) return false;
    // IP letterali (IPv6 tra parentesi quadre), localhost, nomi senza dominio: mai.
    if (IPV4_LITERAL.test(host) || host.startsWith('[') || host.includes(':')) return false;
    if (host === 'localhost' || !host.includes('.')) return false;
    if (isHost(host, 'ytimg.com') || isHost(host, 'youtube.com') || isHost(host, 'ggpht.com')) {
      return false;
    }
    return AUDIUS_CONTENT_IMAGE_PATH.test(url.pathname);
  } catch {
    return false;
  }
}
