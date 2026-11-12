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
