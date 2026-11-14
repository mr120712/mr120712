// @polsia:user-owned — contratto di GET /api/admin/featured-rights/search-hint?q=…: l'avviso «Solo
// per admin» in cima ai risultati della ricerca. Dice all'amministratore se dei "brani in evidenza"
// (lo store Vercel Blob) corrispondono alla query ma NON compaiono perché non sono dichiarati in
// diritti.json, o se diritti.json manca o non vale. Solo CONTEGGI e lo stato del manifest: mai
// titoli, artisti o percorsi (li elenca la pagina «Diritti e testi»). L'oggetto è `strict`: un
// campo in più (per esempio un elenco di titoli aggiunto per sbaglio) fa fallire il parse sul
// server, prima della risposta, e sul client, che allora non mostra nulla.
// È un endpoint SEPARATO e privato: GET /api/music/search-all resta identico per tutti (in cache
// condivisa) e non porta mai questo avviso.
import { z } from 'zod';
import { FeaturedRightsManifestStatusSchema } from '@/lib/contracts/admin-featured-rights';

/** L'endpoint privato dell'avviso (solo admin con email verificata). */
export const ADMIN_SEARCH_HINT_PATH = '/api/admin/featured-rights/search-hint';
/** La pagina admin che spiega brano per brano che cosa vale (titoli e percorsi stanno lì). */
export const ADMIN_RIGHTS_PAGE_PATH = '/admin/diritti-testi';

/** Stessa regola della ricerca unificata: testo ripulito dagli spazi, da 1 a 80 caratteri. */
export const ADMIN_SEARCH_HINT_QUERY_MAX_LENGTH = 80;
export const ADMIN_SEARCH_HINT_QUERY_ERROR = 'Inserisci una ricerca da 1 a 80 caratteri.';

export const AdminSearchHintQuerySchema = z
  .string()
  .trim()
  .min(1, ADMIN_SEARCH_HINT_QUERY_ERROR)
  .max(ADMIN_SEARCH_HINT_QUERY_MAX_LENGTH, ADMIN_SEARCH_HINT_QUERY_ERROR);

const CountSchema = z.number().int().nonnegative();

export const AdminSearchHintSchema = z
  .object({
    /**
     * Stato di diritti.json con le regole della ricerca: 'missing' (non c'è), 'invalid' (non vale,
     * anche oltre 256 KB), 'valid', 'unavailable' (store non configurato o non leggibile). Sempre
     * 'valid' quando la ricerca mostra brani in evidenza per la query (il suo indice usa ancora un
     * manifest valido, anche se è appena cambiato).
     */
    manifest: FeaturedRightsManifestStatusSchema,
    /** Brani in evidenza che la ricerca trova davvero per la query (dal suo stesso indice). */
    matchedDeclared: CountSchema,
    /**
     * Brani in evidenza dello store che corrispondono alla query ma la ricerca NON mostra: non
     * dichiarati (con manifest valido) oppure tutti quelli che corrispondono (manifest assente o
     * non valido). Mai un brano che la ricerca mostra.
     */
    matchedUndeclared: CountSchema,
  })
  .strict();

export type AdminSearchHint = z.infer<typeof AdminSearchHintSchema>;
export type AdminSearchHintManifest = AdminSearchHint['manifest'];
