// @polsia:user-owned — il piano dell'account applicato agli elenchi dei brani DICHIARATI in evidenza
// (route della pagina di una cartella/genere e di un artista): Premium tutti, Free i 30 più recenti
// (featured-plan). Il Premium si controlla solo quando l'elenco supera il tetto Free; se il controllo
// non risponde vale Free (hasPremiumAccess è fail closed).
import 'server-only';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import { FEATURED_FREE_TRACK_LIMIT, featuredTracksForPlan } from '@/lib/music/featured-plan';

export async function featuredTracksForAccount<T>(
  tracks: readonly T[],
  userId: string,
  isPremium: (userId: string) => Promise<boolean> = hasPremiumAccess,
): Promise<{ tracks: T[]; total: number }> {
  // Sotto il tetto Free tutti vedono tutto: nessun controllo del Premium (nessuna query in più).
  if (tracks.length <= FEATURED_FREE_TRACK_LIMIT) return featuredTracksForPlan(tracks, true);
  return featuredTracksForPlan(tracks, await isPremium(userId));
}
