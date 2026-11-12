// Modelli dell'app Solco. Rispecchiano le risposte JSON del backend
// (src/lib/contracts/* del sito). Solo i campi che servono all'app.

class AudiusTrack {
  AudiusTrack({
    required this.id,
    required this.qualifiedId,
    required this.title,
    required this.artistName,
    this.artworkUrl,
    this.durationSeconds,
  });

  final String id;
  final String qualifiedId; // "audius:<id>"
  final String title;
  final String artistName;
  final String? artworkUrl;
  final int? durationSeconds;

  factory AudiusTrack.fromJson(Map<String, dynamic> json) {
    return AudiusTrack(
      id: json['id'] as String,
      qualifiedId: json['qualifiedId'] as String? ?? 'audius:${json['id']}',
      title: (json['title'] as String?) ?? 'Senza titolo',
      artistName: (json['artistName'] as String?) ?? '',
      artworkUrl: json['artworkUrl'] as String?,
      durationSeconds: (json['durationSeconds'] as num?)?.toInt(),
    );
  }

  /// Percorso (relativo all'origine) dello stream Audius sul backend di Solco.
  /// Richiede l'accesso (il cookie di sessione viaggia con la richiesta).
  String get streamPath => '/api/music/audius/tracks/$id/stream';
}

class SessionUser {
  SessionUser({required this.id, required this.name, required this.email});
  final String id;
  final String name;
  final String email;

  factory SessionUser.fromJson(Map<String, dynamic> json) {
    final user = (json['user'] as Map<String, dynamic>?) ?? json;
    return SessionUser(
      id: (user['id'] as String?) ?? '',
      name: (user['name'] as String?) ?? '',
      email: (user['email'] as String?) ?? '',
    );
  }
}

/// Una voce della cronologia (GET /api/music/library → history). Un brano Audius
/// è riproducibile; le altre fonti (radio/podcast/youtube) per ora si mostrano soltanto.
class HistoryEntry {
  HistoryEntry({
    required this.qualifiedId,
    required this.title,
    required this.artistName,
    this.artworkUrl,
    this.durationSeconds,
    required this.playbackMode,
    required this.playCount,
    required this.lastPlayedAt,
  });

  final String qualifiedId;
  final String title;
  final String artistName;
  final String? artworkUrl;
  final int? durationSeconds;
  final String playbackMode; // audius | solco | radio | podcast | jamendo | youtube
  final int playCount;
  final String lastPlayedAt;

  bool get isAudius => playbackMode == 'audius' && qualifiedId.startsWith('audius:');

  AudiusTrack? get audiusTrack {
    if (!isAudius) return null;
    return AudiusTrack(
      id: qualifiedId.substring('audius:'.length),
      qualifiedId: qualifiedId,
      title: title,
      artistName: artistName,
      artworkUrl: artworkUrl,
      durationSeconds: durationSeconds,
    );
  }

  factory HistoryEntry.fromJson(Map<String, dynamic> json) {
    return HistoryEntry(
      qualifiedId: (json['qualifiedId'] as String?) ?? '',
      title: (json['title'] as String?) ?? 'Senza titolo',
      artistName: (json['artistName'] as String?) ?? '',
      artworkUrl: json['artworkUrl'] as String?,
      durationSeconds: (json['durationSeconds'] as num?)?.toInt(),
      playbackMode: (json['playbackMode'] as String?) ?? 'audius',
      playCount: (json['playCount'] as num?)?.toInt() ?? 1,
      lastPlayedAt: (json['lastPlayedAt'] as String?) ?? '',
    );
  }
}

/// Una stazione radio salvata (GET /api/music/library → stations).
class SavedStation {
  SavedStation({
    required this.stationId,
    required this.name,
    this.artworkUrl,
    this.country,
    this.homepage,
  });

  final String stationId;
  final String name;
  final String? artworkUrl;
  final String? country;
  final String? homepage;

  factory SavedStation.fromJson(Map<String, dynamic> json) {
    return SavedStation(
      stationId: (json['stationId'] as String?) ?? '',
      name: (json['name'] as String?) ?? 'Stazione',
      artworkUrl: json['artworkUrl'] as String?,
      country: json['country'] as String?,
      homepage: json['homepage'] as String?,
    );
  }
}

/// Un podcast seguito (GET /api/music/library → podcasts).
class FollowedPodcast {
  FollowedPodcast({
    required this.podcastId,
    required this.title,
    this.author,
    this.artworkUrl,
  });

  final String podcastId;
  final String title;
  final String? author;
  final String? artworkUrl;

  factory FollowedPodcast.fromJson(Map<String, dynamic> json) {
    return FollowedPodcast(
      podcastId: (json['podcastId'] as String?) ?? '',
      title: (json['title'] as String?) ?? 'Podcast',
      author: json['author'] as String?,
      artworkUrl: json['artworkUrl'] as String?,
    );
  }
}

/// La libreria dell'utente in un colpo solo (GET /api/music/library).
class LibraryData {
  LibraryData({
    required this.history,
    required this.stations,
    required this.podcasts,
  });

  final List<HistoryEntry> history;
  final List<SavedStation> stations;
  final List<FollowedPodcast> podcasts;

  bool get isEmpty => history.isEmpty && stations.isEmpty && podcasts.isEmpty;

  factory LibraryData.fromJson(Map<String, dynamic> json) {
    List<T> list<T>(String key, T Function(Map<String, dynamic>) from) =>
        ((json[key] as List?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(from)
            .toList();
    return LibraryData(
      history: list('history', HistoryEntry.fromJson),
      stations: list('stations', SavedStation.fromJson),
      podcasts: list('podcasts', FollowedPodcast.fromJson),
    );
  }
}

/// Un brano dentro una playlist (GET /api/music/collections → items). Solo i
/// brani Audius sono riproducibili nell'app per ora.
class PlaylistItem {
  PlaylistItem({
    required this.id,
    required this.source,
    required this.sourceId,
    this.title,
    this.creatorName,
    this.artworkUrl,
    this.durationSeconds,
  });

  final String id;
  final String source; // audius | youtube | song
  final String sourceId;
  final String? title;
  final String? creatorName;
  final String? artworkUrl;
  final int? durationSeconds;

  bool get isAudius => source == 'audius';

  AudiusTrack? get audiusTrack {
    if (!isAudius) return null;
    return AudiusTrack(
      id: sourceId,
      qualifiedId: 'audius:$sourceId',
      title: title ?? 'Senza titolo',
      artistName: creatorName ?? '',
      artworkUrl: artworkUrl,
      durationSeconds: durationSeconds,
    );
  }

  factory PlaylistItem.fromJson(Map<String, dynamic> json) {
    return PlaylistItem(
      id: (json['id'] as String?) ?? '',
      source: (json['source'] as String?) ?? 'song',
      sourceId: (json['sourceId'] as String?) ?? '',
      title: json['title'] as String?,
      creatorName: json['creatorName'] as String?,
      artworkUrl: json['artworkUrl'] as String?,
      durationSeconds: (json['durationSeconds'] as num?)?.toInt(),
    );
  }
}

/// Una playlist dell'utente (GET /api/music/collections → collections).
class Playlist {
  Playlist({
    required this.id,
    required this.name,
    required this.kind,
    required this.items,
  });

  final String id;
  final String name;
  final String kind;
  final List<PlaylistItem> items;

  int get audiusCount => items.where((item) => item.isAudius).length;
  List<AudiusTrack> get audiusTracks =>
      items.map((item) => item.audiusTrack).whereType<AudiusTrack>().toList();

  factory Playlist.fromJson(Map<String, dynamic> json) {
    final items = ((json['items'] as List?) ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(PlaylistItem.fromJson)
        .toList();
    return Playlist(
      id: (json['id'] as String?) ?? '',
      name: (json['name'] as String?) ?? 'Playlist',
      kind: (json['kind'] as String?) ?? 'playlist',
      items: items,
    );
  }
}
