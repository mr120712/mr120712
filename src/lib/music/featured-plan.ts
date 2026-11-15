// @polsia:user-owned — quanti brani DICHIARATI dei "brani in evidenza" vede un account negli elenchi
// (pagina di una cartella, di un genere o di un artista): Premium tutti, Free i 30 più recenti, con
// il totale per mostrare «30 di N brani» e invitare a Premium. Vale SOLO per i brani con i diritti
// dichiarati in diritti.json: questi elenchi non contengono mai brani non dichiarati, che non sono
// mai un vantaggio del Premium (la Home resta uguale per tutti). Logica pura: client, server e test.

/** Brani dichiarati di un elenco che vede un account Free: i più recenti. */
export const FEATURED_FREE_TRACK_LIMIT = 30;

/** I brani da mandare: Premium tutti, Free i primi 30 (l'elenco arriva già dal più recente). */
export function featuredTracksForPlan<T>(
  tracks: readonly T[],
  premium: boolean,
): { tracks: T[]; total: number } {
  return {
    tracks: premium ? [...tracks] : tracks.slice(0, FEATURED_FREE_TRACK_LIMIT),
    total: tracks.length,
  };
}

/** True quando un account Free vede solo una parte dell'elenco (con Premium ci sono altri brani). */
export function isFeaturedListLimited(shown: number, total: number | undefined): total is number {
  return typeof total === 'number' && total > shown;
}
