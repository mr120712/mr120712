// @polsia:user-owned — generi del Record Pool: brani royalty-free (Open Music License su Audius)
// che l'artista ha reso scaricabili. Curati sui generi dove gli OML abbondano (vedi moods.ts:
// Pop/Electronic/House/Hip-Hop sono quasi tutti "all rights reserved", quindi esclusi).
import type { AudiusGenre } from '@/lib/music/moods';

export type RecordPoolGenre = {
  /** Slug in URL (?genre=techno). */
  slug: string;
  /** Etichetta mostrata sul chip. */
  label: string;
  /** Valore `genre` accettato dall'API Audius. */
  audius: AudiusGenre;
};

export const RECORD_POOL_GENRES: readonly RecordPoolGenre[] = [
  { slug: 'techno', label: 'Techno', audius: 'Techno' },
  { slug: 'drum-and-bass', label: 'Drum & Bass', audius: 'Drum & Bass' },
  { slug: 'dubstep', label: 'Dubstep', audius: 'Dubstep' },
  { slug: 'trap', label: 'Trap', audius: 'Trap' },
  { slug: 'disco', label: 'Disco', audius: 'Disco' },
  { slug: 'funk', label: 'Funk', audius: 'Funk' },
  { slug: 'downtempo', label: 'Downtempo', audius: 'Downtempo' },
  { slug: 'ambient', label: 'Ambient', audius: 'Ambient' },
  { slug: 'lo-fi', label: 'Lo-Fi', audius: 'Lo-Fi' },
  { slug: 'acoustic', label: 'Acustica', audius: 'Acoustic' },
  { slug: 'classical', label: 'Classica', audius: 'Classical' },
  { slug: 'jazz', label: 'Jazz', audius: 'Jazz' },
] as const;

/** I generi Audius curati, usati quando non è scelto un genere specifico ("Tutti"). */
export const RECORD_POOL_ALL_GENRES: readonly AudiusGenre[] = RECORD_POOL_GENRES.map(
  (entry) => entry.audius,
);

export function findRecordPoolGenre(slug: string | null | undefined): RecordPoolGenre | null {
  if (!slug) return null;
  return RECORD_POOL_GENRES.find((entry) => entry.slug === slug) ?? null;
}
