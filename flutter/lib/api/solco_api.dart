import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cookie_jar/cookie_jar.dart';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:path_provider/path_provider.dart';

import 'models.dart';

/// Byte audio + metadati di un download ("scarica il permesso").
class DownloadResult {
  DownloadResult({required this.bytes, required this.meta, required this.contentType});
  final Uint8List bytes;
  final Map<String, dynamic> meta; // header x-solco-download decodificato
  final String contentType;
}

/// Origine del backend di Solco. L'app NON reimplementa il backend: chiama le
/// stesse API del sito. Per provare contro un backend locale cambia qui.
const String kSolcoBaseUrl = 'https://solcomusic.vercel.app';

class SolcoApiException implements Exception {
  SolcoApiException(this.message, {this.statusCode});
  final String message;
  final int? statusCode;
  @override
  String toString() => message;
}

/// Client delle API di Solco. Tiene il cookie di sessione (better-auth) in un
/// cookie-jar persistente, così l'accesso sopravvive al riavvio dell'app.
class SolcoApi {
  SolcoApi._(this._dio, this._jar);

  final Dio _dio;
  final PersistCookieJar _jar;

  static Future<SolcoApi> create() async {
    final dir = await getApplicationSupportDirectory();
    final jar = PersistCookieJar(storage: FileStorage('${dir.path}/solco_cookies'));
    final dio = Dio(BaseOptions(
      baseUrl: kSolcoBaseUrl,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 30),
      headers: {'Accept': 'application/json'},
      // Non lanciare su 4xx: li gestiamo noi.
      validateStatus: (code) => code != null && code < 500,
    ));
    dio.interceptors.add(CookieManager(jar));
    // Le rotte che MODIFICANO dati controllano same-origin (confronto dell'header
    // Origin con NEXT_PUBLIC_APP_URL). Da un'app nativa impostiamo Origin = baseUrl
    // sulle richieste non-GET, così le POST passano il controllo CSRF (come l'SDK).
    dio.interceptors.add(InterceptorsWrapper(onRequest: (options, handler) {
      final method = options.method.toUpperCase();
      if (method != 'GET' && method != 'HEAD') {
        options.headers['Origin'] = kSolcoBaseUrl;
      }
      handler.next(options);
    }));
    return SolcoApi._(dio, jar);
  }

  /// URL assoluto di uno stream, per darlo al lettore audio.
  String streamUrl(String streamPath) => '$kSolcoBaseUrl$streamPath';

  /// I cookie da passare al lettore audio (just_audio) per lo stream protetto.
  Future<Map<String, String>> streamHeaders() async {
    final cookies = await _jar.loadForRequest(Uri.parse(kSolcoBaseUrl));
    if (cookies.isEmpty) return const {};
    final value = cookies.map((c) => '${c.name}=${c.value}').join('; ');
    return {HttpHeaders.cookieHeader: value};
  }

  // --- Autenticazione (better-auth) ---

  Future<SessionUser?> getSession() async {
    try {
      final res = await _dio.get<dynamic>('/api/auth/get-session');
      final data = res.data;
      if (res.statusCode == 200 && data is Map<String, dynamic> && data['user'] != null) {
        return SessionUser.fromJson(data);
      }
      return null;
    } on DioException {
      return null;
    }
  }

  Future<SessionUser> signInEmail(String email, String password) async {
    final res = await _dio.post<dynamic>(
      '/api/auth/sign-in/email',
      data: {'email': email, 'password': password},
    );
    if (res.statusCode == 200) {
      final me = await getSession();
      if (me != null) return me;
    }
    throw SolcoApiException(_authError(res), statusCode: res.statusCode);
  }

  Future<SessionUser> signUpEmail(String name, String email, String password) async {
    final res = await _dio.post<dynamic>(
      '/api/auth/sign-up/email',
      data: {'name': name, 'email': email, 'password': password},
    );
    if (res.statusCode == 200) {
      final me = await getSession();
      if (me != null) return me;
    }
    throw SolcoApiException(_authError(res), statusCode: res.statusCode);
  }

  Future<void> signOut() async {
    try {
      await _dio.post<dynamic>('/api/auth/sign-out');
    } finally {
      await _jar.deleteAll();
    }
  }

  String _authError(Response<dynamic> res) {
    final data = res.data;
    if (data is Map<String, dynamic>) {
      final msg = data['message'] ?? data['error'];
      if (msg is String && msg.isNotEmpty) return msg;
    }
    if (res.statusCode == 401) return 'Email o password non corretti.';
    return 'Accesso non riuscito. Riprova.';
  }

  // --- Catalogo (GET pubblici / con sessione) ---

  /// Tendenze su Audius dalla Home di Solco: GET /api/music/home.
  Future<List<AudiusTrack>> trending() async {
    final res = await _dio.get<dynamic>('/api/music/home');
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) {
      final trending = data['trending'] as Map<String, dynamic>?;
      final tracks = (trending?['tracks'] as List?) ?? const [];
      return tracks
          .whereType<Map<String, dynamic>>()
          .map(AudiusTrack.fromJson)
          .toList();
    }
    throw SolcoApiException('Impossibile caricare le tendenze.', statusCode: res.statusCode);
  }

  /// Ricerca unificata: GET /api/music/search-all. Mentre si scrive NON si
  /// interroga YouTube; qui restiamo su Audius (i brani riproducibili subito).
  Future<List<AudiusTrack>> search(String query) async {
    final q = query.trim();
    if (q.isEmpty) return const [];
    final res = await _dio.get<dynamic>(
      '/api/music/search-all',
      queryParameters: {'q': q},
    );
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) {
      final sources = data['sources'] as Map<String, dynamic>?;
      final audius = sources?['audius'] as Map<String, dynamic>?;
      final tracks = (audius?['tracks'] as List?) ?? const [];
      return tracks
          .whereType<Map<String, dynamic>>()
          .map(AudiusTrack.fromJson)
          .toList();
    }
    throw SolcoApiException('Ricerca non riuscita.', statusCode: res.statusCode);
  }

  /// Ricerca video su YouTube (consenso esplicito, come sul sito): legge
  /// `sources.youtube.videos` dalla ricerca unificata. Si riproducono solo col
  /// player ufficiale YouTube.
  Future<List<YouTubeVideo>> youtubeSearch(String query) async {
    final q = query.trim();
    if (q.isEmpty) return const [];
    final res = await _dio.get<dynamic>(
      '/api/music/search-all',
      queryParameters: {'q': q, 'youtubeConsent': 'accepted'},
    );
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) {
      final sources = data['sources'] as Map<String, dynamic>?;
      final youtube = sources?['youtube'] as Map<String, dynamic>?;
      final videos = (youtube?['videos'] as List?) ?? const [];
      return videos.whereType<Map<String, dynamic>>().map(YouTubeVideo.fromJson).toList();
    }
    throw SolcoApiException('Ricerca YouTube non riuscita.', statusCode: res.statusCode);
  }

  // --- Libreria (GET con sessione) ---

  /// La libreria dell'utente: cronologia, radio salvate, podcast seguiti.
  Future<LibraryData> getLibrary() async {
    final res = await _dio.get<dynamic>('/api/music/library');
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) {
      return LibraryData.fromJson(data);
    }
    if (res.statusCode == 401) {
      throw SolcoApiException('Accedi per vedere la tua libreria.', statusCode: 401);
    }
    throw SolcoApiException('Impossibile caricare la libreria.', statusCode: res.statusCode);
  }

  /// Le playlist dell'utente: GET /api/music/collections.
  Future<List<Playlist>> getCollections() async {
    final res = await _dio.get<dynamic>('/api/music/collections');
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) {
      final collections = (data['collections'] as List?) ?? const [];
      return collections
          .whereType<Map<String, dynamic>>()
          .map(Playlist.fromJson)
          .toList();
    }
    if (res.statusCode == 401) {
      throw SolcoApiException('Accedi per vedere le tue playlist.', statusCode: 401);
    }
    throw SolcoApiException('Impossibile caricare le playlist.', statusCode: res.statusCode);
  }

  // --- Radio e podcast (scoperta) ---

  Future<List<RadioStation>> radioStations({String? query, String? country, int limit = 30}) async {
    final res = await _dio.get<dynamic>('/api/music/radio', queryParameters: {
      if (query != null && query.trim().isNotEmpty) 'q': query.trim(),
      if (country != null && country.isNotEmpty) 'country': country,
      'limit': limit,
    });
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) {
      final stations = (data['stations'] as List?) ?? const [];
      return stations.whereType<Map<String, dynamic>>().map(RadioStation.fromJson).toList();
    }
    throw SolcoApiException('Impossibile caricare le radio.', statusCode: res.statusCode);
  }

  Future<List<Podcast>> podcasts({String? query}) async {
    final res = await _dio.get<dynamic>('/api/music/podcasts', queryParameters: {
      if (query != null && query.trim().isNotEmpty) 'q': query.trim(),
    });
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) {
      final list = (data['podcasts'] as List?) ?? const [];
      return list.whereType<Map<String, dynamic>>().map(Podcast.fromJson).toList();
    }
    throw SolcoApiException('Impossibile caricare i podcast.', statusCode: res.statusCode);
  }

  Future<PodcastDetail> podcastDetail(String id) async {
    final res = await _dio.get<dynamic>('/api/music/podcasts/$id');
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) {
      return PodcastDetail.fromJson(data);
    }
    throw SolcoApiException('Impossibile caricare il podcast.', statusCode: res.statusCode);
  }

  /// Trascrizione di un episodio (tag podcast:transcript del feed). Il server
  /// scarica e analizza il file; qui non serve autenticazione.
  Future<PodcastTranscript> podcastTranscript(String podcastId, String episodeKey) async {
    final res = await _dio.get<dynamic>(
      '/api/music/podcasts/$podcastId/episodes/$episodeKey/transcript',
    );
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) {
      return PodcastTranscript.fromJson(data);
    }
    throw SolcoApiException('Trascrizione non disponibile.', statusCode: res.statusCode);
  }

  // --- Libreria (mutazioni: Origin impostato dall'interceptor) ---

  /// Registra un ascolto nella cronologia. Best-effort: non deve mai rompere la riproduzione.
  Future<void> recordPlay(PlayableItem item) async {
    String cut(String value, int max) =>
        value.length > max ? value.substring(0, max) : value;
    final artist = item.subtitle.trim().isEmpty ? item.sourceLabel : item.subtitle.trim();
    try {
      await _dio.post<dynamic>('/api/music/library', data: {
        'action': 'record_play',
        'track': {
          'qualifiedId': item.qualifiedId,
          'title': cut(item.title, 400),
          'artistName': cut(artist, 300),
          'artworkUrl': item.artworkUrl,
          'sourceLabel': cut(item.sourceLabel, 80),
          'sourceUrl': null,
          'albumId': null,
          'durationSeconds': item.durationSeconds,
          'playbackMode': item.playbackMode,
        },
      });
    } on DioException {
      // Ignorato apposta.
    }
  }

  Future<void> clearHistory() => _libraryMutation({'action': 'clear_history'});

  Future<void> unsaveStation(String stationId) =>
      _libraryMutation({'action': 'unsave_station', 'stationId': stationId});

  Future<void> unfollowPodcast(String podcastId) =>
      _libraryMutation({'action': 'unfollow_podcast', 'podcastId': podcastId});

  Future<void> _libraryMutation(Map<String, dynamic> body) async {
    final res = await _dio.post<dynamic>('/api/music/library', data: body);
    if (res.statusCode != 200) {
      throw SolcoApiException('Operazione non riuscita.', statusCode: res.statusCode);
    }
  }

  // --- Collezioni: Preferiti e playlist (Origin impostato dall'interceptor) ---

  /// Aggiunge un brano ai Preferiti (collezione speciale, creata se manca).
  Future<void> addFavorite(String source, String sourceId) => _collectionMutation(
        {'action': 'favorite', 'source': source, 'sourceId': sourceId},
      );

  /// Rimuove un elemento da una collezione (es. togliere dai Preferiti).
  Future<void> removeCollectionItem(String collectionId, String itemId) => _collectionMutation(
        {'action': 'remove_item', 'collectionId': collectionId, 'itemId': itemId},
      );

  Future<void> _collectionMutation(Map<String, dynamic> body) async {
    final res = await _dio.post<dynamic>('/api/music/collections', data: body);
    if (res.statusCode != 200) {
      if (res.statusCode == 401) {
        throw SolcoApiException('Accedi per gestire i Preferiti.', statusCode: 401);
      }
      throw SolcoApiException('Operazione non riuscita.', statusCode: res.statusCode);
    }
  }

  // --- Download offline ("scarica il permesso") ---

  Future<DownloadResult> downloadAudiusTrack(String trackId) =>
      _download('/api/music/audius/tracks/$trackId/download');

  Future<DownloadResult> downloadPodcastEpisode(String podcastId, String episodeKey) =>
      _download('/api/music/podcasts/$podcastId/episodes/$episodeKey/download');

  /// POST che restituisce i byte audio + i metadati nell'header x-solco-download.
  /// In caso di errore il corpo è JSON {error, message} (letto dai byte).
  Future<DownloadResult> _download(String path) async {
    final res = await _dio.post<List<int>>(
      path,
      options: Options(responseType: ResponseType.bytes, headers: {'Accept': '*/*'}),
    );
    final status = res.statusCode ?? 0;
    final body = res.data ?? const <int>[];
    if (status == 200) {
      final header = res.headers.value('x-solco-download');
      if (header == null) {
        throw SolcoApiException('Risposta di download senza metadati.', statusCode: status);
      }
      final meta = jsonDecode(utf8.decode(base64Decode(header))) as Map<String, dynamic>;
      return DownloadResult(
        bytes: Uint8List.fromList(body),
        meta: meta,
        contentType: res.headers.value('content-type') ?? 'audio/mpeg',
      );
    }
    var message = 'Download non riuscito.';
    try {
      final decoded = jsonDecode(utf8.decode(body));
      if (decoded is Map && decoded['message'] is String) {
        message = decoded['message'] as String;
      }
    } catch (_) {}
    throw SolcoApiException(message, statusCode: status);
  }

  // --- Premium: acquisti in-app (Apple/Google) ---

  /// Stato dell'abbonamento in-app dell'utente. Fail-soft: in caso di errore, "non attivo".
  Future<ProStatus> getProStatus() async {
    try {
      final res = await _dio.get<dynamic>('/api/solco-pro/iap/status');
      final data = res.data;
      if (res.statusCode == 200 && data is Map<String, dynamic>) {
        return ProStatus.fromJson(data);
      }
    } on DioException {
      // Ignorato: lo stato si rilegge più tardi.
    }
    return ProStatus.none;
  }

  /// Catalogo degli acquisti in-app + token di account (da passare allo store).
  Future<IapCatalog> getIapCatalog() async {
    final res = await _dio.get<dynamic>('/api/solco-pro/iap/products');
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) {
      return IapCatalog.fromJson(data);
    }
    if (res.statusCode == 401) {
      throw SolcoApiException('Accedi per attivare Premium.', statusCode: 401);
    }
    throw SolcoApiException('Impossibile caricare i piani.', statusCode: res.statusCode);
  }

  /// Verifica lato server un acquisto in-app. `token` è il transactionId (Apple) o il
  /// purchaseToken (Google). Il server rilegge lo stato autorevole dallo store.
  Future<IapVerifyResult> verifyIapPurchase({
    required String platform,
    required String productId,
    required String token,
  }) async {
    final res = await _dio.post<dynamic>('/api/solco-pro/iap/verify', data: {
      'platform': platform,
      'productId': productId,
      'token': token,
    });
    final data = res.data;
    if (data is Map<String, dynamic>) return IapVerifyResult.fromJson(data);
    return const IapVerifyResult(ok: false, reason: 'store_error');
  }
}
