import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';

import '../api/models.dart';
import '../api/solco_api.dart';

/// Lettore audio dell'app. Usa just_audio con just_audio_background, così la
/// riproduzione continua in background e compaiono i comandi sulla schermata di
/// blocco (play/pausa/avanti/indietro), come sul sito.
///
/// Riproduce lo stream Audius servito dal backend di Solco, passando il cookie
/// di sessione nelle intestazioni (lo stream richiede l'accesso).
class PlayerController extends ChangeNotifier {
  PlayerController(this._api);

  final SolcoApi _api;
  final AudioPlayer _player = AudioPlayer();

  List<AudiusTrack> _queue = const [];
  int _index = -1;

  AudioPlayer get player => _player;
  AudiusTrack? get current => (_index >= 0 && _index < _queue.length) ? _queue[_index] : null;
  bool get hasNext => _index + 1 < _queue.length;
  bool get hasPrevious => _index > 0;

  Future<void> playQueue(List<AudiusTrack> tracks, int startIndex) async {
    if (tracks.isEmpty) return;
    _queue = List.unmodifiable(tracks);
    _index = startIndex.clamp(0, tracks.length - 1);
    await _loadCurrent();
    await _player.play();
    notifyListeners();
  }

  Future<void> _loadCurrent() async {
    final track = current;
    if (track == null) return;
    final headers = await _api.streamHeaders();
    final source = AudioSource.uri(
      Uri.parse(_api.streamUrl(track.streamPath)),
      headers: headers,
      tag: MediaItem(
        id: track.qualifiedId,
        title: track.title,
        artist: track.artistName,
        artUri: track.artworkUrl != null ? Uri.tryParse(track.artworkUrl!) : null,
        duration: track.durationSeconds != null
            ? Duration(seconds: track.durationSeconds!)
            : null,
      ),
    );
    try {
      await _player.setAudioSource(source);
    } catch (e) {
      debugPrint('Solco: impossibile caricare lo stream: $e');
      rethrow;
    }
  }

  Future<void> togglePlay() async {
    if (_player.playing) {
      await _player.pause();
    } else {
      await _player.play();
    }
    notifyListeners();
  }

  Future<void> next() async {
    if (!hasNext) return;
    _index += 1;
    await _loadCurrent();
    await _player.play();
    notifyListeners();
  }

  Future<void> previous() async {
    if (!hasPrevious) return;
    _index -= 1;
    await _loadCurrent();
    await _player.play();
    notifyListeners();
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }
}
