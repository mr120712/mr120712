// @polsia:user-owned — copertine disegnate delle playlist divertenti di Solco (genre-catalog.ts,
// famiglia «divertenti»). Qui solo gli identificativi e la descrizione di ciò che c'è nel disegno
// (testo alternativo); il disegno in SVG sta in components/custom/music/playlist-cover.tsx.
// Nessuna dipendenza: lo leggono il catalogo, le pagine server e i test.

export const PLAYLIST_COVER_IDS = [
  'comodino',
  'caffe',
  'doccia',
  'traffico',
  'scopa',
  'cuscino',
  'pizza',
  'zanzara',
  'manubrio',
  'lampadina',
  'biglietto',
  'pentola',
  'portatile',
  'libri',
] as const;
export type PlaylistCoverId = (typeof PLAYLIST_COVER_IDS)[number];

/** Che cosa mostra il disegno: testo alternativo quando la copertina sta da sola. */
export const PLAYLIST_COVER_LABELS: Record<PlaylistCoverId, string> = {
  comodino: 'Un comodino di legno con la lampada accesa e un piede che ne urta lo spigolo',
  caffe: 'Una tazza di caffè fumante su un piattino, con il sole che sorge',
  doccia: 'Un soffione della doccia con gocce d’acqua e note musicali',
  traffico: 'Un’auto ferma in coda con le luci dei freni accese, vista da dietro',
  scopa: 'Una scopa e un secchio con le bolle di sapone',
  cuscino: 'Un cuscino bianco sotto una falce di luna, con tre Z nell’aria',
  pizza: 'Una fetta di pizza con salame e basilico',
  zanzara: 'Una zanzara in volo davanti alla luna',
  manubrio: 'Un manubrio da palestra accanto a un calendario con il primo del mese',
  lampadina: 'Una lampadina spenta con la faccia triste e una bolletta in euro',
  biglietto: 'Un biglietto della fila con il numero 342 sotto un tabellone che segna 17',
  pentola: 'Una pentola rossa sul fuoco con il vapore e un cucchiaio di legno',
  portatile: 'Un computer portatile in videochiamata con il microfono spento',
  libri: 'Una pila di libri con una lampada da tavolo e una sveglia che segna le due',
};

export function isPlaylistCoverId(value: unknown): value is PlaylistCoverId {
  return typeof value === 'string' && (PLAYLIST_COVER_IDS as readonly string[]).includes(value);
}
