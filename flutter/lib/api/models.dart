// Modelli dell'app Solco. Rispecchiano le risposte JSON del backend
// (src/lib/contracts/* del sito). Solo i campi che servono all'app.

/// Un'unità riproducibile dal lettore, indipendente dalla fonte (Audius, radio,
/// podcast). Lo `streamPath` è relativo all'origine; il lettore vi antepone il
/// baseUrl e passa il cookie di sessione.
class PlayableItem {
  PlayableItem({
    required this.qualifiedId,
    required this.title,
    required this.subtitle,
    this.artworkUrl,
    required this.streamPath,
    this.durationSeconds,
    this.isLive = false,
    required this.sourceLabel,
    required this.playbackMode,
    this.localPath,
  });

  final String qualifiedId;
  final String title;
  final String subtitle;
  final String? artworkUrl;
  final String streamPath;
  final int? durationSeconds;
  final bool isLive;
  final String sourceLabel; // "Audius" | "Radio" | nome del podcast
  final String playbackMode; // audius | radio | podcast
  /// Percorso di un file scaricato: se presente, si riproduce OFFLINE da qui.
  final String? localPath;

  bool get isOffline => localPath != null;
}

String _sourceLabelForMode(String mode) => switch (mode) {
      'radio' => 'Radio',
      'podcast' => 'Podcast',
      _ => 'Audius',
    };

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
  String get streamPath => '/api/music/audius/tracks/$id/stream';

  PlayableItem toPlayable() => PlayableItem(
        qualifiedId: qualifiedId,
        title: title,
        subtitle: artistName,
        artworkUrl: artworkUrl,
        streamPath: streamPath,
        durationSeconds: durationSeconds,
        sourceLabel: 'Audius',
        playbackMode: 'audius',
      );
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

/// Una voce della cronologia (GET /api/music/library → history). Audius, radio e
/// podcast sono riproducibili; le altre fonti (jamendo/youtube) per ora no.
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
  final String playbackMode;
  final int playCount;
  final String lastPlayedAt;

  /// Ricostruisce l'unità riproducibile dall'identificativo qualificato.
  /// Null per jamendo/youtube (non riproducibili nell'app per ora).
  PlayableItem? toPlayable() {
    final q = qualifiedId;
    String? path;
    String? mode;
    if (q.startsWith('audius:')) {
      path = '/api/music/audius/tracks/${q.substring(7)}/stream';
      mode = 'audius';
    } else if (q.startsWith('radio:')) {
      path = '/api/music/radio/${q.substring(6)}/stream';
      mode = 'radio';
    } else if (q.startsWith('podcast:')) {
      final rest = q.substring(8);
      final tilde = rest.indexOf('~');
      if (tilde > 0) {
        path =
            '/api/music/podcasts/${rest.substring(0, tilde)}/episodes/${rest.substring(tilde + 1)}/stream';
        mode = 'podcast';
      }
    }
    if (path == null || mode == null) return null;
    return PlayableItem(
      qualifiedId: q,
      title: title,
      subtitle: artistName,
      artworkUrl: artworkUrl,
      streamPath: path,
      durationSeconds: durationSeconds,
      isLive: mode == 'radio',
      sourceLabel: _sourceLabelForMode(mode),
      playbackMode: mode,
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

  PlayableItem toPlayable() => PlayableItem(
        qualifiedId: 'radio:$stationId',
        title: name,
        subtitle: country ?? 'Radio',
        artworkUrl: artworkUrl,
        streamPath: '/api/music/radio/$stationId/stream',
        isLive: true,
        sourceLabel: 'Radio',
        playbackMode: 'radio',
      );

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

/// Un brano dentro una playlist (GET /api/music/collections → items).
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

/// Una stazione radio dalla scoperta (GET /api/music/radio → stations).
class RadioStation {
  RadioStation({
    required this.id,
    required this.name,
    this.artworkUrl,
    this.country,
    this.tags = const [],
    this.bitrate,
  });

  final String id;
  final String name;
  final String? artworkUrl;
  final String? country;
  final List<String> tags;
  final int? bitrate;

  PlayableItem toPlayable() => PlayableItem(
        qualifiedId: 'radio:$id',
        title: name,
        subtitle: country ?? 'Radio',
        artworkUrl: artworkUrl,
        streamPath: '/api/music/radio/$id/stream',
        isLive: true,
        sourceLabel: 'Radio',
        playbackMode: 'radio',
      );

  factory RadioStation.fromJson(Map<String, dynamic> json) {
    return RadioStation(
      id: (json['id'] as String?) ?? '',
      name: (json['name'] as String?) ?? 'Stazione',
      artworkUrl: json['artworkUrl'] as String?,
      country: json['country'] as String?,
      tags: ((json['tags'] as List?) ?? const []).whereType<String>().toList(),
      bitrate: (json['bitrate'] as num?)?.toInt(),
    );
  }
}

/// Un podcast dalla scoperta (GET /api/music/podcasts → podcasts).
class Podcast {
  Podcast({
    required this.id,
    required this.title,
    this.author,
    this.artworkUrl,
    this.genre,
  });

  final String id;
  final String title;
  final String? author;
  final String? artworkUrl;
  final String? genre;

  factory Podcast.fromJson(Map<String, dynamic> json) {
    return Podcast(
      id: (json['id'] as String?) ?? '',
      title: (json['title'] as String?) ?? 'Podcast',
      author: json['author'] as String?,
      artworkUrl: json['artworkUrl'] as String?,
      genre: json['genre'] as String?,
    );
  }
}

/// Un episodio di un podcast (GET /api/music/podcasts/<id> → episodes).
class PodcastEpisode {
  PodcastEpisode({
    required this.key,
    required this.title,
    this.publishedAt,
    this.durationSeconds,
    this.description,
    this.artworkUrl,
  });

  final String key;
  final String title;
  final String? publishedAt;
  final int? durationSeconds;
  final String? description;
  final String? artworkUrl;

  PlayableItem toPlayable({
    required String podcastId,
    required String podcastTitle,
    String? podcastArtwork,
  }) =>
      PlayableItem(
        qualifiedId: 'podcast:$podcastId~$key',
        title: title,
        subtitle: podcastTitle,
        artworkUrl: artworkUrl ?? podcastArtwork,
        streamPath: '/api/music/podcasts/$podcastId/episodes/$key/stream',
        durationSeconds: durationSeconds,
        sourceLabel: podcastTitle,
        playbackMode: 'podcast',
      );

  factory PodcastEpisode.fromJson(Map<String, dynamic> json) {
    return PodcastEpisode(
      key: (json['key'] as String?) ?? '',
      title: (json['title'] as String?) ?? 'Episodio',
      publishedAt: json['publishedAt'] as String?,
      durationSeconds: (json['durationSeconds'] as num?)?.toInt(),
      description: json['description'] as String?,
      artworkUrl: json['artworkUrl'] as String?,
    );
  }
}

/// Dettaglio di un podcast con i suoi episodi (GET /api/music/podcasts/<id>).
class PodcastDetail {
  PodcastDetail({required this.podcast, required this.episodes});
  final Podcast? podcast;
  final List<PodcastEpisode> episodes;

  factory PodcastDetail.fromJson(Map<String, dynamic> json) {
    final podcastJson = json['podcast'] as Map<String, dynamic>?;
    return PodcastDetail(
      podcast: podcastJson != null ? Podcast.fromJson(podcastJson) : null,
      episodes: ((json['episodes'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(PodcastEpisode.fromJson)
          .toList(),
    );
  }
}

/// Un video YouTube dalla ricerca (GET /api/music/search-all → sources.youtube.videos).
/// Si riproduce solo col player ufficiale YouTube (IFrame API in un WebView).
class YouTubeVideo {
  YouTubeVideo({
    required this.videoId,
    required this.title,
    required this.channelTitle,
    this.thumbnailUrl,
    this.description,
    this.publishedAt,
  });

  final String videoId;
  final String title;
  final String channelTitle;
  final String? thumbnailUrl;
  final String? description;
  final String? publishedAt;

  factory YouTubeVideo.fromJson(Map<String, dynamic> json) {
    return YouTubeVideo(
      videoId: (json['videoId'] as String?) ?? '',
      title: (json['title'] as String?) ?? 'Senza titolo',
      channelTitle: (json['channelTitle'] as String?) ?? '',
      thumbnailUrl: json['thumbnailUrl'] as String?,
      description: json['description'] as String?,
      publishedAt: json['publishedAt'] as String?,
    );
  }
}

/// Un brano scaricato sul dispositivo ("scarica il permesso"). Metadati salvati
/// nell'indice locale; il file audio sta su disco in `filePath`.
class DownloadedTrack {
  DownloadedTrack({
    required this.downloadKey,
    required this.qualifiedId,
    required this.title,
    this.artist,
    this.album,
    this.artworkUrl,
    this.durationSeconds,
    required this.mimeType,
    required this.source,
    required this.filePath,
    this.creditLine,
    this.sourceName,
    this.licenseName,
    this.licenseUrl,
    this.sourceUrl,
  });

  final String downloadKey;
  final String qualifiedId;
  final String title;
  final String? artist;
  final String? album;
  final String? artworkUrl;
  final int? durationSeconds;
  final String mimeType;
  final String source; // audius-download | podcast-download
  final String filePath;
  final String? creditLine;
  final String? sourceName;
  final String? licenseName;
  final String? licenseUrl;
  final String? sourceUrl;

  String get playbackMode => source == 'podcast-download' ? 'podcast' : 'audius';
  String get sourceLabel =>
      source == 'podcast-download' ? (album ?? 'Podcast') : 'Audius';

  PlayableItem toPlayable() => PlayableItem(
        qualifiedId: qualifiedId,
        title: title,
        subtitle: artist ?? sourceLabel,
        artworkUrl: artworkUrl,
        streamPath: '',
        durationSeconds: durationSeconds,
        sourceLabel: sourceLabel,
        playbackMode: playbackMode,
        localPath: filePath,
      );

  Map<String, dynamic> toJson() => {
        'downloadKey': downloadKey,
        'qualifiedId': qualifiedId,
        'title': title,
        'artist': artist,
        'album': album,
        'artworkUrl': artworkUrl,
        'durationSeconds': durationSeconds,
        'mimeType': mimeType,
        'source': source,
        'filePath': filePath,
        'creditLine': creditLine,
        'sourceName': sourceName,
        'licenseName': licenseName,
        'licenseUrl': licenseUrl,
        'sourceUrl': sourceUrl,
      };

  factory DownloadedTrack.fromJson(Map<String, dynamic> json) {
    return DownloadedTrack(
      downloadKey: (json['downloadKey'] as String?) ?? '',
      qualifiedId: (json['qualifiedId'] as String?) ?? '',
      title: (json['title'] as String?) ?? 'Senza titolo',
      artist: json['artist'] as String?,
      album: json['album'] as String?,
      artworkUrl: json['artworkUrl'] as String?,
      durationSeconds: (json['durationSeconds'] as num?)?.toInt(),
      mimeType: (json['mimeType'] as String?) ?? 'audio/mpeg',
      source: (json['source'] as String?) ?? 'audius-download',
      filePath: (json['filePath'] as String?) ?? '',
      creditLine: json['creditLine'] as String?,
      sourceName: json['sourceName'] as String?,
      licenseName: json['licenseName'] as String?,
      licenseUrl: json['licenseUrl'] as String?,
      sourceUrl: json['sourceUrl'] as String?,
    );
  }
}

/// Stato dell'abbonamento in-app dell'utente (GET /api/solco-pro/iap/status).
class ProStatus {
  const ProStatus({required this.active, this.validUntil, this.planId});
  final bool active;
  final DateTime? validUntil;
  final String? planId;

  factory ProStatus.fromJson(Map<String, dynamic> json) => ProStatus(
        active: json['active'] == true,
        validUntil: json['validUntil'] is String
            ? DateTime.tryParse(json['validUntil'] as String)
            : null,
        planId: json['planId'] as String?,
      );

  static const none = ProStatus(active: false);
}

/// Un prodotto in-app offerto dal catalogo del backend.
class IapProduct {
  const IapProduct({
    required this.productId,
    required this.planId,
    required this.period,
    required this.label,
  });
  final String productId;
  final String planId;
  final String period; // month | year
  final String label;

  factory IapProduct.fromJson(Map<String, dynamic> json) => IapProduct(
        productId: json['productId'] as String,
        planId: (json['planId'] as String?) ?? '',
        period: (json['period'] as String?) ?? 'month',
        label: (json['label'] as String?) ?? '',
      );
}

/// Catalogo IAP: prodotti, disponibilità per piattaforma e token di account (UUID da passare
/// allo store per legare l'acquisto a questo utente). GET /api/solco-pro/iap/products.
class IapCatalog {
  const IapCatalog({
    required this.available,
    required this.appleAvailable,
    required this.googleAvailable,
    required this.products,
    required this.accountToken,
  });
  final bool available;
  final bool appleAvailable;
  final bool googleAvailable;
  final List<IapProduct> products;
  final String accountToken;

  factory IapCatalog.fromJson(Map<String, dynamic> json) {
    final platforms = json['platforms'] as Map<String, dynamic>? ?? const {};
    final list = (json['products'] as List?) ?? const [];
    return IapCatalog(
      available: json['available'] == true,
      appleAvailable: platforms['apple'] == true,
      googleAvailable: platforms['google'] == true,
      products:
          list.whereType<Map<String, dynamic>>().map(IapProduct.fromJson).toList(),
      accountToken: (json['accountToken'] as String?) ?? '',
    );
  }
}

/// Esito della verifica di un acquisto in-app (POST /api/solco-pro/iap/verify).
class IapVerifyResult {
  const IapVerifyResult({required this.ok, this.active = false, this.reason});
  final bool ok;
  final bool active;
  final String? reason;

  factory IapVerifyResult.fromJson(Map<String, dynamic> json) => IapVerifyResult(
        ok: json['ok'] == true,
        active: json['active'] == true,
        reason: json['reason'] as String?,
      );
}
