// @polsia:user-owned — mood della Home (chip in alto): per ognuno, i filtri Audius (mood e generi
// verificati sull'API pubblica), i tag Radio Browser, una ricerca podcast in italiano e le playlist
// Solco collegate. Nessuna ricerca YouTube: i mood rimandano solo alle playlist del catalogo generi.

/** Valori `mood` che l'API Audius accetta davvero (filtro array su /v1/tracks/search). */
export const AUDIUS_MOODS = [
  'Peaceful',
  'Easygoing',
  'Tender',
  'Romantic',
  'Sensual',
  'Sentimental',
  'Yearning',
  'Melancholy',
  'Brooding',
  'Cool',
  'Sophisticated',
  'Energizing',
  'Upbeat',
  'Excited',
  'Empowering',
  'Aggressive',
  'Fiery',
  'Rowdy',
  'Stirring',
  'Defiant',
  'Gritty',
  'Serious',
] as const;
export type AudiusMood = (typeof AUDIUS_MOODS)[number];

/**
 * Valori `genre` che l'API Audius accetta davvero (filtro array su /v1/tracks/search). Manca
 * 'Dance': esiste, ma ha appena una ventina di brani in tutto e nessuno riproducibile da Solco.
 */
export const AUDIUS_GENRES = [
  'Electronic',
  'Ambient',
  'Lo-Fi',
  'Acoustic',
  'Classical',
  'Jazz',
  'Hip-Hop/Rap',
  'R&B/Soul',
  'Pop',
  'House',
  'Deep House',
  'Techno',
  'Trap',
  'Drum & Bass',
  'Dubstep',
  'Latin',
  'Alternative',
  'Downtempo',
  'Funk',
  'Disco',
] as const;
export type AudiusGenre = (typeof AUDIUS_GENRES)[number];

export const MOOD_IDS = [
  'relax',
  'energia',
  'allenamento',
  'concentrazione',
  'festa',
  'malinconia',
  'romantico',
  'notte',
] as const;
export type MoodId = (typeof MOOD_IDS)[number];

/** Nome dell'icona lucide-react del mood (la UI la risolve in un componente). */
export const MOOD_ICON_NAMES = [
  'Waves',
  'Zap',
  'Dumbbell',
  'Brain',
  'PartyPopper',
  'CloudRain',
  'Heart',
  'Moon',
] as const;
export type MoodIconName = (typeof MOOD_ICON_NAMES)[number];

/** Parametro dell'URL della Home che tiene il mood scelto (?mood=relax). */
export const MOOD_QUERY_PARAM = 'mood';

export type MoodEntry = {
  id: MoodId;
  label: string;
  icon: MoodIconName;
  /** Una riga in italiano, sotto il titolo del mood. */
  description: string;
  /** Filtri Audius: i brani devono avere uno dei mood e uno dei generi (2-4 ciascuno). */
  audius: { moods: readonly AudiusMood[]; genres: readonly AudiusGenre[] };
  /** Tag Radio Browser (minuscoli), dal più adatto. */
  radioTags: readonly string[];
  /** Ricerca nella directory podcast (in italiano). */
  podcastTerm: string;
  /** Slug del catalogo generi Solco (playlist collegate); nessuna ricerca YouTube aggiuntiva. */
  genreSlugs: readonly string[];
};

export const moodCatalog: readonly MoodEntry[] = [
  {
    id: 'relax',
    label: 'Relax',
    icon: 'Waves',
    description: 'Suoni morbidi per rallentare e staccare la spina.',
    audius: {
      moods: ['Peaceful', 'Easygoing', 'Tender'],
      genres: ['Ambient', 'Lo-Fi', 'Downtempo', 'Acoustic'],
    },
    radioTags: ['chillout', 'lounge', 'ambient'],
    podcastTerm: 'meditazione',
    genreSlugs: ['lofi-studio', 'ambient', 'downtempo'],
  },
  {
    id: 'energia',
    label: 'Energia',
    icon: 'Zap',
    description: 'Ritmi carichi e ritornelli che accendono la giornata.',
    // Pop, Electronic e House sono quasi tutti "All rights reserved": questi generi hanno brani OML.
    audius: {
      moods: ['Energizing', 'Upbeat', 'Excited', 'Empowering'],
      genres: ['Techno', 'Funk', 'Alternative', 'Disco'],
    },
    radioTags: ['edm', 'dance', 'pop'],
    podcastTerm: 'motivazione',
    // Non 'club-latino' e 'afro-night', già in Festa: elettronica veloce che nessun altro mood collega.
    genreSlugs: ['hyperpop', 'uk-garage', 'breakbeat'],
  },
  {
    id: 'allenamento',
    label: 'Allenamento',
    icon: 'Dumbbell',
    description: 'Bassi pesanti e tempi veloci per spingere fino all’ultima serie.',
    // Senza Hip-Hop/Rap: occupava due terzi dei 100 risultati, quasi tutti "All rights reserved"
    // (misurato: 15 brani riproducibili, contro 32 di 20 artisti con questi tre generi).
    audius: {
      moods: ['Empowering', 'Aggressive', 'Fiery', 'Energizing'],
      genres: ['Dubstep', 'Drum & Bass', 'Trap'],
    },
    radioTags: ['workout', 'edm'],
    podcastTerm: 'allenamento',
    genreSlugs: ['phonk-drift', 'trap', 'drum-and-bass'],
  },
  {
    id: 'concentrazione',
    label: 'Concentrazione',
    icon: 'Brain',
    description: 'Beat discreti e note lunghe per studiare e lavorare senza distrazioni.',
    audius: {
      moods: ['Peaceful', 'Cool', 'Sophisticated'],
      genres: ['Lo-Fi', 'Ambient', 'Classical'],
    },
    // Non 'classical': su Radio Browser le più votate sono soprattutto recitazioni e pop del Maghreb.
    radioTags: ['lofi', 'piano', 'study'],
    podcastTerm: 'produttività',
    genreSlugs: ['lofi-studio', 'lofi-hip-hop', 'post-rock'],
  },
  {
    id: 'festa',
    label: 'Festa',
    icon: 'PartyPopper',
    description: 'Pista piena: disco, funk e ritmi latini.',
    audius: {
      moods: ['Excited', 'Upbeat', 'Rowdy'],
      genres: ['Disco', 'Latin', 'Funk'],
    },
    radioTags: ['dance', 'house', 'disco'],
    // 'dj set' trova soprattutto set personali minori; così escono gli show dance più seguiti.
    podcastTerm: 'musica dance',
    genreSlugs: ['club-latino', 'afro-night', 'deep-house'],
  },
  {
    id: 'malinconia',
    label: 'Malinconia',
    icon: 'CloudRain',
    description: 'Canzoni lente e voci intime per i giorni grigi.',
    // Ambient al posto di R&B/Soul (quasi tutto "All rights reserved"): misurato, più brani
    // riproducibili e più artisti diversi.
    audius: {
      moods: ['Melancholy', 'Yearning', 'Sentimental', 'Brooding'],
      genres: ['Alternative', 'Acoustic', 'Ambient'],
    },
    radioTags: ['indie', 'acoustic'],
    podcastTerm: 'poesia',
    genreSlugs: ['bedroom-pop', 'dream-pop', 'darkwave'],
  },
  {
    id: 'romantico',
    label: 'Romantico',
    icon: 'Heart',
    description: 'Ballate, soul e atmosfere da lume di candela.',
    // Senza Pop: per lo più "All rights reserved", toglieva posti ai brani riproducibili.
    audius: {
      moods: ['Romantic', 'Sensual', 'Tender'],
      genres: ['R&B/Soul', 'Jazz', 'Acoustic'],
    },
    radioTags: ['love', 'romantic'],
    podcastTerm: 'amore',
    genreSlugs: ['neo-soul', 'nu-jazz', 'jazz-fusion'],
  },
  {
    id: 'notte',
    label: 'Notte',
    icon: 'Moon',
    description: 'Atmosfere scure e suoni lenti per le ore piccole, fino al sonno.',
    // Calma e scura come promette la descrizione. Senza Cool, Deep House ed Electronic, che
    // portavano remix da club; senza Peaceful, che riporta i brani di Relax e Concentrazione.
    // Misurato dal vivo: 28 brani riproducibili, 20 mostrati da 13 artisti, nessuno in comune con
    // Relax o Concentrazione.
    audius: {
      moods: ['Brooding', 'Melancholy'],
      genres: ['Ambient', 'Downtempo'],
    },
    radioTags: ['sleep', 'ambient', 'chillout'],
    // Non 'sonno': trova anche fantascienza e titoli in tedesco ("Sonne").
    podcastTerm: 'dormire',
    // Playlist calme, come promette la descrizione (niente techno da club né synthwave). 'ambient'
    // è anche in Relax: il catalogo non ha un'altra playlist calma da sonno ('dark-ambient' è la
    // stessa ricerca di 'dark-ambient-notte'); 'vaporwave', lenta, al posto del lo-fi di
    // Concentrazione.
    genreSlugs: ['dark-ambient-notte', 'ambient', 'vaporwave'],
  },
];

export function isMoodId(value: unknown): value is MoodId {
  return typeof value === 'string' && (MOOD_IDS as readonly string[]).includes(value);
}

/** Il mood con questo id; null per valori sconosciuti (che la Home tratta come "Tutto"). */
export function findMood(id: string | null | undefined): MoodEntry | null {
  if (!isMoodId(id)) return null;
  return moodCatalog.find((entry) => entry.id === id) ?? null;
}
