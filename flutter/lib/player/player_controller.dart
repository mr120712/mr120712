import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';

import '../api/models.dart';
import '../api/solco_api.dart';

enum RepeatMode { none, all, one }

/// Lettore audio dell'app. Usa just_audio con just_audio_background, così la
/// riproduzione continua in background e compaiono i comandi sulla schermata di
/// blocco (play/pausa/avanti/indietro), come sul sito.
///
/// Gestisce una coda di brani Audius con avanti/indietro, shuffle, ripetizione e
/// avanzamento automatico a fine brano. Ogni brano viene caricato dal suo stream
/// servito dal backend di Solco, con il cookie di sessione nelle intestazioni.
class PlayerController extends ChangeNotifier {
  PlayerController(this._api) {
    _stateSub = _player.playerStateStream.listen(_onPlayerState);
  }

  final SolcoApi _api;
  final AudioPlayer _player = AudioPlayer();
  final Random _random = Random();

  /// Ordine originale (come passato a playQueue), per ripristinare lo shuffle.
  List<AudiusTrack> _original = const [];

  /// Ordine di riproduzione corrente (uguale a _original, oppure mescolato).
  List<AudiusTrack> _queue = const [];
  int _index = -1;

  RepeatMode _repeat = RepeatMode.none;
  bool _shuffle = false;
  bool _advancing = false;
  late final StreamSubscription<PlayerState> _stateSub;

  AudioPlayer get player => _player;
  AudiusTrack? get current =>
      (_index >= 0 && _index < _queue.length) ? _queue[_index] : null;
  List<AudiusTrack> get queue => List.unmodifiable(_queue);
  int get index => _index;
  bool get hasNext => _index + 1 < _queue.length || _repeat == RepeatMode.all;
  bool get hasPrevious => _index > 0 || _repeat == RepeatMode.all;
  RepeatMode get repeatMode => _repeat;
  bool get shuffleEnabled => _shuffle;
  bool get playing => _player.playing;

  Stream<Duration> get positionStream => _player.positionStream;
  Stream<Duration> get bufferedPositionStream => _player.bufferedPositionStream;
  Stream<Duration?> get durationStream => _player.durationStream;
  Stream<PlayerState> get playerStateStream => _player.playerStateStream;

  Future<void> playQueue(List<AudiusTrack> tracks, int startIndex) async {
    if (tracks.isEmpty) return;
    _original = List.unmodifiable(tracks);
    if (_shuffle) {
      final start = tracks[startIndex.clamp(0, tracks.length - 1)];
      _queue = _shuffledFrom(start);
      _index = 0;
    } else {
      _queue = _original;
      _index = startIndex.clamp(0, tracks.length - 1);
    }
    await _loadCurrent();
    await _player.play();
    notifyListeners();
  }

  List<AudiusTrack> _shuffledFrom(AudiusTrack first) {
    final rest = _original.where((t) => t.qualifiedId != first.qualifiedId).toList();
    for (var i = rest.length - 1; i > 0; i--) {
      final j = _random.nextInt(i + 1);
      final tmp = rest[i];
      rest[i] = rest[j];
      rest[j] = tmp;
    }
    return List.unmodifiable([first, ...rest]);
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
      // Registra l'ascolto nella cronologia (best-effort, non attende).
      unawaited(_api.recordPlay(track));
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

  Future<void> seek(Duration position) => _player.seek(position);

  Future<void> next() async {
    if (_queue.isEmpty) return;
    if (_index + 1 < _queue.length) {
      _index += 1;
    } else if (_repeat == RepeatMode.all) {
      _index = 0;
    } else {
      return;
    }
    await _loadCurrent();
    await _player.play();
    notifyListeners();
  }

  Future<void> previous() async {
    if (_queue.isEmpty) return;
    // Come i lettori comuni: se sono passati >3s, torna all'inizio del brano.
    if (_player.position > const Duration(seconds: 3)) {
      await _player.seek(Duration.zero);
      return;
    }
    if (_index > 0) {
      _index -= 1;
    } else if (_repeat == RepeatMode.all) {
      _index = _queue.length - 1;
    } else {
      await _player.seek(Duration.zero);
      return;
    }
    await _loadCurrent();
    await _player.play();
    notifyListeners();
  }

  void cycleRepeat() {
    _repeat = switch (_repeat) {
      RepeatMode.none => RepeatMode.all,
      RepeatMode.all => RepeatMode.one,
      RepeatMode.one => RepeatMode.none,
    };
    _player.setLoopMode(_repeat == RepeatMode.one ? LoopMode.one : LoopMode.off);
    notifyListeners();
  }

  void toggleShuffle() {
    _shuffle = !_shuffle;
    final track = current;
    if (track != null) {
      if (_shuffle) {
        _queue = _shuffledFrom(track);
        _index = 0;
      } else {
        _queue = _original;
        _index = _queue.indexWhere((t) => t.qualifiedId == track.qualifiedId);
        if (_index < 0) _index = 0;
      }
    }
    notifyListeners();
  }

  Future<void> _onPlayerState(PlayerState state) async {
    notifyListeners();
    if (state.processingState != ProcessingState.completed) return;
    // LoopMode.one ripete da solo; qui gestiamo solo "nessuna" e "tutta la coda".
    if (_repeat == RepeatMode.one || _advancing) return;
    _advancing = true;
    try {
      if (_index + 1 < _queue.length) {
        await next();
      } else if (_repeat == RepeatMode.all) {
        _index = 0;
        await _loadCurrent();
        await _player.play();
        notifyListeners();
      } else {
        await _player.pause();
        await _player.seek(Duration.zero);
      }
    } finally {
      _advancing = false;
    }
  }

  @override
  void dispose() {
    _stateSub.cancel();
    _player.dispose();
    super.dispose();
  }
}
