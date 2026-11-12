import 'dart:io';

import 'package:cookie_jar/cookie_jar.dart';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:path_provider/path_provider.dart';

import 'models.dart';

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

  // --- Libreria (mutazioni: Origin impostato dall'interceptor) ---

  /// Registra un ascolto nella cronologia. Best-effort: non deve mai rompere la riproduzione.
  Future<void> recordPlay(AudiusTrack track) async {
    final artist = track.artistName.trim().isEmpty ? 'Sconosciuto' : track.artistName.trim();
    try {
      await _dio.post<dynamic>('/api/music/library', data: {
        'action': 'record_play',
        'track': {
          'qualifiedId': track.qualifiedId,
          'title': track.title,
          'artistName': artist,
          'artworkUrl': track.artworkUrl,
          'sourceLabel': 'Audius',
          'sourceUrl': null,
          'albumId': null,
          'durationSeconds': track.durationSeconds,
          'playbackMode': 'audius',
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
}
