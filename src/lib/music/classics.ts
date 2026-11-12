// @polsia:user-owned — "Classici per decennio": playlist curate che ripercorrono i SUONI di ogni
// decennio (60/70/80/90), costruite dal catalogo musicale lecito di Solco (Audius: artisti
// indipendenti e Creative Commons), filtrando per genere/mood evocativi dell'epoca.
//
// NON sono le incisioni originali protette da copyright: quelle non si possono ospitare né
// scaricare. Qui si tratta di scoperta e ascolto di brani leciti nello stile di ogni decennio.
import type { AudiusGenre, AudiusMood } from '@/lib/music/moods';

export type ClassicsPlaylistDef = {
  /** Id stabile, unico nel decennio. */
  id: string;
  title: string;
  description: string;
  /** Generi Audius della playlist (almeno uno). */
  genres: readonly AudiusGenre[];
  /** Mood Audius opzionali, per restringere. */
  moods?: readonly AudiusMood[];
};

export type ClassicsDecade = {
  /** Slug in URL (?decade=70s). */
  slug: '60s' | '70s' | '80s' | '90s';
  label: string;
  /** Una riga sotto il titolo del decennio. */
  tagline: string;
  playlists: readonly ClassicsPlaylistDef[];
};

export const CLASSICS_DECADES: readonly ClassicsDecade[] = [
  {
    slug: '60s',
    label: 'Anni 60',
    tagline: 'Soul, R&B, jazz e folk: le radici del suono moderno.',
    playlists: [
      {
        id: 'soul-rnb',
        title: 'Soul & R&B',
        description: 'Voci calde e groove, nello spirito del soul anni 60.',
        genres: ['R&B/Soul'],
        moods: ['Tender', 'Sentimental', 'Empowering'],
      },
      {
        id: 'jazz',
        title: 'Jazz & Swing',
        description: 'Standard e improvvisazione, dal cool al vivace.',
        genres: ['Jazz'],
        moods: ['Cool', 'Sophisticated'],
      },
      {
        id: 'folk-acustica',
        title: 'Folk & Acustica',
        description: 'Chitarre e cantautorato, il folk che ha fatto scuola.',
        genres: ['Acoustic'],
        moods: ['Peaceful', 'Yearning'],
      },
    ],
  },
  {
    slug: '70s',
    label: 'Anni 70',
    tagline: 'Funk, disco e soul: la decade che ha fatto ballare il mondo.',
    playlists: [
      {
        id: 'funk-disco',
        title: 'Funk & Disco',
        description: 'Groove in levare e basslines da pista, stile anni 70.',
        genres: ['Funk', 'Disco'],
        moods: ['Upbeat', 'Excited'],
      },
      {
        id: 'soul-groove',
        title: 'Soul & Groove',
        description: 'Il lato caldo e ritmico del soul.',
        genres: ['R&B/Soul', 'Funk'],
        moods: ['Sensual', 'Easygoing'],
      },
      {
        id: 'jazz-fusion',
        title: 'Jazz & Fusion',
        description: 'Jazz elettrico e contaminazioni, come negli anni 70.',
        genres: ['Jazz'],
        moods: ['Sophisticated', 'Stirring'],
      },
    ],
  },
  {
    slug: '80s',
    label: 'Anni 80',
    tagline: 'Sintetizzatori, new wave e il primo hip-hop.',
    playlists: [
      {
        id: 'synth-electronic',
        title: 'Synth & Electronic',
        description: 'Suoni sintetici e arpeggi, il cuore elettronico degli anni 80.',
        genres: ['Electronic'],
        moods: ['Energizing', 'Cool'],
      },
      {
        id: 'hip-hop-old-school',
        title: 'Hip-Hop old school',
        description: 'Beat e rime nello spirito delle origini.',
        genres: ['Hip-Hop/Rap'],
        moods: ['Rowdy', 'Defiant'],
      },
      {
        id: 'pop-new-wave',
        title: 'Pop & New Wave',
        description: 'Melodie pop e new wave dal taglio anni 80.',
        genres: ['Pop', 'Alternative'],
        moods: ['Upbeat', 'Brooding'],
      },
    ],
  },
  {
    slug: '90s',
    label: 'Anni 90',
    tagline: 'Hip-hop, house e techno: club e cultura urbana.',
    playlists: [
      {
        id: 'hip-hop',
        title: 'Hip-Hop anni 90',
        description: 'Boom bap e groove, lo stile hip-hop dei 90.',
        genres: ['Hip-Hop/Rap'],
        moods: ['Cool', 'Gritty'],
      },
      {
        id: 'house-techno',
        title: 'House & Techno',
        description: 'Quattro quarti da club, come nelle notti anni 90.',
        genres: ['House', 'Techno'],
        moods: ['Energizing', 'Excited'],
      },
      {
        id: 'rnb-groove',
        title: 'R&B & Groove',
        description: 'Il lato morbido e ritmato degli anni 90.',
        genres: ['R&B/Soul'],
        moods: ['Sensual', 'Easygoing'],
      },
    ],
  },
] as const;

export function findClassicsDecade(slug: string | null | undefined): ClassicsDecade | null {
  if (!slug) return null;
  return CLASSICS_DECADES.find((decade) => decade.slug === slug) ?? null;
}
