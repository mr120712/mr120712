// @polsia:user-owned — chiavi dei brani SCARICATI nella libreria sul dispositivo.
//
// Ogni record di 'tracks' ha una `sourceKey` anti-duplicato, di due forme che non possono mai
// coincidere:
//  - file dell'ascoltatore (store.ts, sourceKeyFor): JSON di [nome, dimensione, data di modifica].
//    Il secondo elemento è sempre un NUMERO;
//  - download (downloadSourceKey, qui): JSON di ['download', fonte, chiave]. Tre STRINGHE.
// Per questo dalla sourceKey si può dire con certezza se un record è un download, di quale fonte
// e con quale chiave, qualunque nome abbia un file dell'ascoltatore (anche "download" o
// "featured:…"): readDownloadSourceKey accetta SOLO la forma esatta scritta da downloadSourceKey.
//
// Serve a tre cose:
//  - esporre ai lettori la chiave del download (LocalTrack.downloadKey), mai per un file locale;
//  - riconoscere la copia offline di un "brano in evidenza" anche se il campo `source` del record
//    è andato perso. È successo ai record salvati prima che la libreria conoscesse la fonte
//    'featured-download': rileggendola come 'local', setTrackDuration la riscriveva così. La
//    chiave 'featured:<shareId>' è rimasta intatta e dice ancora che cos'è il file. Questa regola
//    RESTA per sempre: una scheda rimasta aperta con la versione precedente può ancora riscrivere
//    un record così, e la riparazione sul disco (store.ts, repairFeaturedCopySources) arriva dopo;
//  - riconoscere il download di una fonte che QUESTA versione non conosce (isUnknownDownloadSourceKey):
//    un record così non è un file dell'ascoltatore e non va né mostrato né riscritto, altrimenti
//    si ripete lo stesso guasto con la prossima fonte.
//
// Modulo puro (nessun IndexedDB): lo importano reader.ts (quindi il player) e store.ts.

import { FEATURED_DOWNLOAD_KEY_PREFIX } from '@/lib/contracts/offline';
import { type DownloadedTrackSource, isDownloadedTrackSource } from '@/lib/local-music/types';
import { isFeaturedShareId } from '@/lib/music/featured-share';

/** Primo elemento della sourceKey di un download: un file locale ha qui il suo nome. */
const DOWNLOAD_MARKER = 'download';
/** Come comincia la sourceKey di ogni download (un controllo veloce prima di JSON.parse). */
const DOWNLOAD_KEY_START = `[${JSON.stringify(DOWNLOAD_MARKER)},`;

/**
 * Chiave anti-duplicato di un download: il primo elemento è la stringa 'download', il secondo la
 * fonte, così non può mai coincidere con la chiave di un file locale ([nome, dimensione, data]).
 */
export function downloadSourceKey(source: DownloadedTrackSource, downloadKey: string): string {
  return JSON.stringify([DOWNLOAD_MARKER, source, downloadKey]);
}

export type DownloadSourceKey = { source: DownloadedTrackSource; downloadKey: string };

/**
 * La sourceKey letta come terna di un download, QUALUNQUE fonte nomini: ['download', fonte,
 * chiave], tre stringhe, nella forma canonica che scrive downloadSourceKey (nessuno spazio, nessun
 * elemento in più, nessun'altra codifica). null per tutto il resto. Un file dell'ascoltatore torna
 * sempre null: la sua chiave ha un numero (la dimensione) dove un download ha la fonte.
 */
function readDownloadShape(sourceKey: unknown): { source: string; downloadKey: string } | null {
  if (typeof sourceKey !== 'string' || !sourceKey.startsWith(DOWNLOAD_KEY_START)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceKey);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [marker, source, downloadKey] = parsed as unknown[];
  if (marker !== DOWNLOAD_MARKER || typeof source !== 'string' || typeof downloadKey !== 'string') {
    return null;
  }
  return JSON.stringify([DOWNLOAD_MARKER, source, downloadKey]) === sourceKey
    ? { source, downloadKey }
    : null;
}

/**
 * Fonte e chiave di un download dalla sourceKey di un record, o null se la sourceKey non è
 * ESATTAMENTE quella che scrive downloadSourceKey per una fonte che questa versione conosce. Un
 * file dell'ascoltatore torna sempre null.
 */
export function readDownloadSourceKey(sourceKey: unknown): DownloadSourceKey | null {
  const shape = readDownloadShape(sourceKey);
  if (!shape || !isDownloadedTrackSource(shape.source) || shape.downloadKey.length === 0) {
    return null;
  }
  return { source: shape.source, downloadKey: shape.downloadKey };
}

/**
 * True se la sourceKey ha la forma esatta di un download ma nomina una fonte che questa versione
 * NON conosce: il record l'ha scritto una versione più recente (un'altra scheda, un bundle più
 * nuovo). Non è un file dell'ascoltatore e non si sa che cosa sia: reader.ts lo scarta in lettura,
 * così non viene elencato, riprodotto, letto per il testo né riscritto. È il guasto già successo
 * a 'featured-download' (riletta come 'local' e riscritta così): non deve ripetersi con la
 * prossima fonte. Un file dell'ascoltatore non ha mai questa forma, qualunque nome abbia.
 */
export function isUnknownDownloadSourceKey(sourceKey: unknown): boolean {
  const shape = readDownloadShape(sourceKey);
  return shape !== null && !isDownloadedTrackSource(shape.source);
}

/**
 * L'id opaco (shareId) del brano in evidenza da una chiave di download 'featured:<shareId>', o
 * null se la chiave non ha esattamente quella forma (prefisso + 22 caratteri [A-Za-z0-9_-], la
 * stessa di isFeaturedShareId in src/lib/music/featured-share). Solo la forma: se il brano esiste
 * e se la copia è ancora consentita lo dice il server.
 */
export function featuredCopyShareId(downloadKey: unknown): string | null {
  if (typeof downloadKey !== 'string' || !downloadKey.startsWith(FEATURED_DOWNLOAD_KEY_PREFIX)) {
    return null;
  }
  const shareId = downloadKey.slice(FEATURED_DOWNLOAD_KEY_PREFIX.length);
  return isFeaturedShareId(shareId) ? shareId : null;
}

/**
 * True se la sourceKey di un record è ESATTAMENTE quella della copia offline di un brano in
 * evidenza: ['download', 'featured-download', 'featured:<shareId valido>']. È la regola con cui
 * reader.ts rilegge come 'featured-download' un record il cui campo `source` è stato riscritto
 * come 'local'. Un file dell'ascoltatore il cui NOME comincia con "featured:" non la soddisfa.
 */
export function isFeaturedCopySourceKey(sourceKey: unknown): boolean {
  const download = readDownloadSourceKey(sourceKey);
  return (
    download?.source === 'featured-download' && featuredCopyShareId(download.downloadKey) !== null
  );
}
