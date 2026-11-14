// @polsia:user-owned — quali copertine possono finire in un'anteprima social (playlist e brani
// condivisi). Modulo puro, usato dal client (se mettere la copertina nel link) e dal server (prima
// di scaricarla per disegnare l'anteprima). Solo copertine Audius: mai miniature YouTube, perché le
// piattaforme social conservano l'immagine dell'anteprima senza scadenza, mentre i dati della
// YouTube API si tengono meno di 30 giorni.

/** `/content/<cid>/<size>.jpg`: il percorso delle copertine sui nodi della rete Audius. */
const AUDIUS_CONTENT_IMAGE_PATH =
  /^\/content\/[A-Za-z0-9]{20,128}\/(?:150x150|480x480|1000x1000)\.(?:jpg|jpeg|png)$/i;

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isHost(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Copertina Audius che l'anteprima social può scaricare: solo https verso i domini Audius o il
 * percorso delle copertine dei nodi Audius, mai IP, porte o credenziali. Le miniature YouTube
 * (i.ytimg.com) sono escluse.
 */
export function isShareableCoverUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    // IP letterali (IPv6 tra parentesi quadre), localhost, nomi senza dominio: mai.
    if (IPV4_LITERAL.test(host) || host.startsWith('[') || host.includes(':')) return false;
    if (host === 'localhost' || !host.includes('.')) return false;
    if (isHost(host, 'ytimg.com') || isHost(host, 'youtube.com') || isHost(host, 'ggpht.com')) {
      return false;
    }
    return (
      isHost(host, 'audius.co') ||
      isHost(host, 'audius.org') ||
      AUDIUS_CONTENT_IMAGE_PATH.test(url.pathname)
    );
  } catch {
    return false;
  }
}
