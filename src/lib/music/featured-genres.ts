// @polsia:user-owned — «Per genere» dei "brani in evidenza" (logica pura, client, server e test): il
// genere che l'amministratore scrive in diritti.json ("genere" di una voce) raggruppa i brani
// DICHIARATI in cartelle per genere. In Home una fila compatta di riquadri (uno per genere, con il
// mosaico delle copertine e il numero di brani) apre la pagina /cartella/<id> del genere, la stessa
// delle cartelle dello store. Solo i brani dichiarati: un brano senza voce valida in diritti.json
// non ha genere, non è contato e non compare mai in queste cartelle (lo store contiene anche brani
// commerciali senza licenza). L'id lo calcola SOLO il server (featured-genres.server).

/** Lunghezza massima del nome di un genere ("genere" in diritti.json). */
export const FEATURED_GENRE_NAME_MAX = 40;
/** Quanti riquadri «Per genere» al massimo in Home (i generi con più brani). */
export const FEATURED_HOME_GENRES_MAX = 24;
/** Copertine di un riquadro (mosaico 2×2, come le playlist). */
export const FEATURED_GENRE_COVERS = 4;

/** Caratteri di controllo (a capo, tabulazioni, invisibili C0/C1): mai in un nome di genere. */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/** True per un nome di genere accettabile: testo con caratteri visibili, senza caratteri di controllo. */
export function isFeaturedGenreName(value: string): boolean {
  return value.trim().length > 0 && !CONTROL_CHARACTERS.test(value);
}

/** Il nome come si mostra: spazi ai lati tolti e spazi interni ridotti a uno, forma NFC. */
export function featuredGenreLabel(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/**
 * La chiave che raggruppa i brani: stesso nome senza distinguere maiuscole e spazi ("Rap italiano",
 * "rap  Italiano" e " RAP ITALIANO " sono lo stesso genere).
 */
export function featuredGenreKey(value: string): string {
  return featuredGenreLabel(value).toLocaleLowerCase('it');
}

/** «1 brano» / «N brani», per i riquadri dei generi. */
export function featuredGenreCount(count: number): string {
  return count === 1 ? '1 brano' : `${count} brani`;
}
