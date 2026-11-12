import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../api/models.dart';
import '../api/solco_api.dart';

/// Gestisce i brani scaricati sul dispositivo: i file audio su disco e un indice
/// JSON dei metadati. Scarica solo ciò che le licenze permettono (Audius
/// scaricabile, episodi podcast), riusando le rotte "scarica il permesso".
class OfflineStore {
  OfflineStore(this._api, this.dir);
  final SolcoApi _api;
  final Directory dir;

  static Future<OfflineStore> create(SolcoApi api) async {
    final base = await getApplicationSupportDirectory();
    final dir = Directory('${base.path}/solco_downloads');
    if (!await dir.exists()) await dir.create(recursive: true);
    return OfflineStore(api, dir);
  }

  File get _indexFile => File('${dir.path}/index.json');

  Future<List<DownloadedTrack>> list() async {
    if (!await _indexFile.exists()) return const [];
    try {
      final data = jsonDecode(await _indexFile.readAsString());
      if (data is! List) return const [];
      return data.whereType<Map<String, dynamic>>().map(DownloadedTrack.fromJson).toList();
    } catch (_) {
      return const [];
    }
  }

  Future<bool> isDownloaded(String qualifiedId) async =>
      (await list()).any((d) => d.qualifiedId == qualifiedId);

  Future<void> _writeIndex(List<DownloadedTrack> items) async {
    await _indexFile.writeAsString(jsonEncode(items.map((d) => d.toJson()).toList()));
  }

  /// Scarica e salva un brano consentito. Lancia [SolcoApiException] se la fonte
  /// non è scaricabile o il backend rifiuta (403/429/…).
  Future<DownloadedTrack> download(PlayableItem item) async {
    final DownloadResult result;
    if (item.playbackMode == 'audius') {
      final id = item.qualifiedId.startsWith('audius:')
          ? item.qualifiedId.substring(7)
          : item.qualifiedId;
      result = await _api.downloadAudiusTrack(id);
    } else if (item.playbackMode == 'podcast') {
      final rest = item.qualifiedId.startsWith('podcast:')
          ? item.qualifiedId.substring(8)
          : item.qualifiedId;
      final tilde = rest.indexOf('~');
      if (tilde <= 0) throw SolcoApiException('Episodio non valido.');
      result = await _api.downloadPodcastEpisode(
          rest.substring(0, tilde), rest.substring(tilde + 1));
    } else {
      throw SolcoApiException('Questa fonte non è scaricabile.');
    }

    final meta = result.meta;
    final source = (meta['source'] as String?) ??
        (item.playbackMode == 'podcast' ? 'podcast-download' : 'audius-download');
    final downloadKey = (meta['downloadKey'] as String?) ?? item.qualifiedId;
    final attribution = meta['attribution'] as Map<String, dynamic>?;
    final fileName = '${_safeName(downloadKey)}.${_extForMime(result.contentType)}';
    final file = File('${dir.path}/$fileName');
    await file.writeAsBytes(result.bytes, flush: true);

    final track = DownloadedTrack(
      downloadKey: downloadKey,
      qualifiedId: item.qualifiedId,
      title: (meta['title'] as String?) ?? item.title,
      artist: meta['artist'] as String?,
      album: meta['album'] as String?,
      artworkUrl: item.artworkUrl,
      durationSeconds: (meta['durationSeconds'] as num?)?.toInt() ?? item.durationSeconds,
      mimeType: (meta['mimeType'] as String?) ?? result.contentType,
      source: source,
      filePath: file.path,
      creditLine: attribution?['creditLine'] as String?,
      sourceName: attribution?['sourceName'] as String?,
      licenseName: attribution?['licenseName'] as String?,
      licenseUrl: attribution?['licenseUrl'] as String?,
      sourceUrl: attribution?['sourceUrl'] as String?,
    );

    final items = (await list()).where((d) => d.qualifiedId != item.qualifiedId).toList()
      ..add(track);
    await _writeIndex(items);
    return track;
  }

  Future<void> delete(String qualifiedId) async {
    final remaining = <DownloadedTrack>[];
    for (final d in await list()) {
      if (d.qualifiedId == qualifiedId) {
        try {
          final f = File(d.filePath);
          if (await f.exists()) await f.delete();
        } catch (_) {}
      } else {
        remaining.add(d);
      }
    }
    await _writeIndex(remaining);
  }

  String _extForMime(String mime) {
    final m = mime.split(';').first.trim().toLowerCase();
    return switch (m) {
      'audio/mpeg' => 'mp3',
      'audio/mp4' || 'audio/x-m4a' || 'audio/aac' => 'm4a',
      'audio/ogg' || 'audio/opus' => 'ogg',
      'audio/wav' || 'audio/x-wav' => 'wav',
      'audio/flac' => 'flac',
      _ => 'audio',
    };
  }

  String _safeName(String key) => key.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
}
