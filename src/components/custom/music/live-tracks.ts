// @polsia:user-owned — conversione di stazioni, episodi e cronologia in brani del player.
import type { MusicPlayerTrack } from '@/components/custom/music/music-player';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import type {
  HistoryEntry,
  JamendoTrack,
  Podcast,
  PodcastEpisode,
  RadioStation,
  SavedStation,
} from '@/lib/contracts/library';

/**
 * Un "brano in evidenza" della Home (file messo dall'amministratore nello store Blob) → elemento del
 * player. Stream diretto dall'URL pubblico Blob. durationSeconds 0/sconosciuta → null, così il player
 * legge la durata reale dai metadati dell'audio alla riproduzione.
 */
export function homeTrackToTrack(track: HomeTrack): MusicPlayerTrack {
  return {
    qualifiedId: `upload:${track.id}`,
    title: track.title,
    artistName: track.artist ?? 'Solco',
    // Copertina (stesso nome, cartella o incorporata): anche nel player e sulla schermata di blocco.
    artworkUrl: track.artworkUrl ?? null,
    sourceLabel: 'In evidenza',
    sourceUrl: null,
    durationSeconds: track.durationSeconds > 0 ? track.durationSeconds : null,
    streamUrl: track.streamUrl,
    playbackMode: 'upload',
  };
}
/** Un brano della libreria pubblica → elemento del player (stream diretto dall'URL pubblico Blob). */
export function publicUploadToTrack(upload: {
  id: string;
  title: string;
  artist: string | null;
  streamUrl: string | null;
  durationSeconds: number;
}): MusicPlayerTrack {
  return {
    qualifiedId: `upload:${upload.id}`,
    title: upload.title,
    artistName: upload.artist ?? 'Caricato dagli utenti',
    artworkUrl: null,
    sourceLabel: 'Caricato dagli utenti',
    sourceUrl: null,
    durationSeconds: upload.durationSeconds,
    streamUrl: upload.streamUrl,
    playbackMode: 'upload',
  };
}

export function stationToTrack(station: RadioStation): MusicPlayerTrack {
  return {
    qualifiedId: `radio:${station.id}`,
    title: station.name,
    artistName: station.country ?? 'Radio dal vivo',
    artworkUrl: station.artworkUrl,
    sourceLabel: 'Radio dal vivo',
    sourceUrl: station.homepage,
    sourceUrlLabel: 'Sito della stazione',
    durationSeconds: null,
    playbackMode: 'radio',
  };
}

export function savedStationToStation(station: SavedStation): RadioStation {
  return {
    id: station.stationId,
    name: station.name,
    artworkUrl: station.artworkUrl,
    country: station.country,
    countryCode: null,
    tags: (station.tags ?? '').split(',').filter(Boolean),
    codec: null,
    bitrate: null,
    homepage: station.homepage,
    votes: 0,
  };
}

export function stationToSaved(station: RadioStation): SavedStation {
  return {
    stationId: station.id,
    name: station.name,
    artworkUrl: station.artworkUrl,
    country: station.country,
    tags: station.tags.join(',').slice(0, 400) || null,
    homepage: station.homepage,
  };
}

export function episodeToTrack(podcast: Podcast, episode: PodcastEpisode): MusicPlayerTrack {
  return {
    qualifiedId: `podcast:${podcast.id}~${episode.key}`,
    title: episode.title,
    artistName: podcast.title,
    artworkUrl: episode.artworkUrl ?? podcast.artworkUrl,
    sourceLabel: 'Podcast',
    sourceUrl: `https://podcasts.apple.com/podcast/id${podcast.id}`,
    sourceUrlLabel: 'Scheda pubblica del podcast',
    durationSeconds: episode.durationSeconds,
    playbackMode: 'podcast',
  };
}

export function historyToTrack(entry: HistoryEntry): MusicPlayerTrack {
  return {
    qualifiedId: entry.qualifiedId,
    title: entry.title,
    artistName: entry.artistName,
    artworkUrl: entry.artworkUrl,
    sourceLabel: entry.sourceLabel,
    sourceUrl: entry.sourceUrl,
    albumId: entry.albumId,
    durationSeconds: entry.durationSeconds,
    playbackMode: entry.playbackMode,
  };
}

export function jamendoToTrack(track: JamendoTrack): MusicPlayerTrack {
  return {
    qualifiedId: `jamendo:${track.id}`,
    title: track.title,
    artistName: track.artistName,
    artworkUrl: track.artworkUrl,
    sourceLabel: 'Jamendo',
    sourceUrl: track.pageUrl,
    sourceUrlLabel: 'Brano su Jamendo (licenza Creative Commons)',
    durationSeconds: track.durationSeconds,
    playbackMode: 'jamendo',
  };
}

export type YouTubeVideoLike = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string | null;
  durationSeconds?: number | null;
};

export function videoToTrack(video: YouTubeVideoLike): MusicPlayerTrack {
  return {
    qualifiedId: `youtube:${video.videoId}`,
    title: video.title,
    artistName: video.channelTitle,
    artworkUrl: video.thumbnailUrl,
    sourceLabel: 'YouTube',
    sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`,
    sourceUrlLabel: 'Guarda su YouTube',
    durationSeconds: video.durationSeconds ?? null,
    playbackMode: 'youtube',
  };
}
