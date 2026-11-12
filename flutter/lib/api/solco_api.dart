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
}
