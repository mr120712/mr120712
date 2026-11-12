import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';

import '../api/models.dart';
import '../api/solco_api.dart';

enum RepeatMode { none, all, one }

/// Lettore audio dell'app. Usa just_audio con just_audio_background (background +
/// comandi dalla schermata di blocco). Riproduce una coda di [PlayableItem]
/// (Audius, radio live, episodi podcast) con avanti/indietro, shuffle,
/// ripetizione e avanzamento automatico a fine brano.
class PlayerController extends ChangeNotifier {
  PlayerController(this._api) {
    _stateSub = _player.playerStateStream.listen(_onPlayerState);
  }

  final SolcoApi _api;
  final AudioPlayer _player = AudioPlayer();
  final Random _random = Random();

  List<PlayableItem> _original = const [];
  List<PlayableItem> _queue = const [];
  int _index = -1;

  RepeatMode _repeat = RepeatMode.none;
  bool _shuffle = false;
  bool _advancing = false;
  double _speed = 1.0;
  Timer? _sleepTimer;
  DateTime? _sleepEndsAt;
  bool _sleepAtTrackEnd = false;
  late final StreamSubscription<PlayerState> _stateSub;

  AudioPlayer get player => _player;
  PlayableItem? get current =>
      (_index >= 0 && _index < _queue.length) ? _queue[_index] : null;
  List<PlayableItem> get queue => List.unmodifiable(_queue);
  int get index => _index;
  bool get hasNext => _index + 1 < _queue.length || _repeat == RepeatMode.all;
  bool get hasPrevious => _index > 0 || _repeat == RepeatMode.all;
  RepeatMode get repeatMode => _repeat;
  bool get shuffleEnabled => _shuffle;
  bool get playing => _player.playing;
  double get speed => _speed;
  bool get sleepTimerActive => _sleepTimer != null || _sleepAtTrackEnd;
  DateTime? get sleepEndsAt => _sleepEndsAt;
  bool get sleepAtTrackEnd => _sleepAtTrackEnd;

  Stream<Duration> get positionStream => _player.positionStream;
  Stream<Duration> get bufferedPositionStream => _player.bufferedPositionStream;
  Stream<Duration?> get durationStream => _player.durationStream;
  Stream<PlayerState> get playerStateStream => _player.playerStateStream;

  /// Riproduce una coda di brani Audius (scorciatoia usata dalle schermate del catalogo).
  Future<void> playQueue(List<AudiusTrack> tracks, int startIndex) =>
      playItems(tracks.map((t) => t.toPlayable()).toList(), startIndex);

  /// Riproduce una coda di unità generiche (Audius, radio, podcast).
  Future<void> playItems(List<PlayableItem> items, int startIndex) async {
    if (items.isEmpty) return;
    _original = List.unmodifiable(items);
    if (_shuffle && items.length > 1) {
      final start = items[startIndex.clamp(0, items.length - 1)];
      _queue = _shuffledFrom(start);
      _index = 0;
    } else {
      _queue = _original;
      _index = startIndex.clamp(0, items.length - 1);
    }
    await _loadCurrent();
    await _player.play();
    notifyListeners();
  }

  List<PlayableItem> _shuffledFrom(PlayableItem first) {
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
    final item = current;
    if (item == null) return;
    final offline = item.localPath != null;
    final uri = offline ? Uri.file(item.localPath!) : Uri.parse(_api.streamUrl(item.streamPath));
    final headers = offline ? null : await _api.streamHeaders();
    final source = AudioSource.uri(
      uri,
      headers: headers,
      tag: MediaItem(
        id: item.qualifiedId,
        title: item.title,
        artist: item.subtitle,
        artUri: item.artworkUrl != null ? Uri.tryParse(item.artworkUrl!) : null,
        duration: item.durationSeconds != null && !item.isLive
            ? Duration(seconds: item.durationSeconds!)
            : null,
      ),
    );
    try {
      await _player.setAudioSource(source);
      // Mantieni la velocità scelta anche al cambio brano.
      if (_speed != 1.0) await _player.setSpeed(_speed);
      // La cronologia richiede rete: solo per la riproduzione in streaming.
      if (!offline) unawaited(_api.recordPlay(item));
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

  /// Velocità di riproduzione (utile per i podcast). Resta valida anche al brano successivo.
  Future<void> setSpeed(double value) async {
    _speed = value;
    await _player.setSpeed(value);
    notifyListeners();
  }

  /// Timer di spegnimento: mette in pausa dopo [duration].
  void startSleepTimer(Duration duration) {
    cancelSleepTimer();
    _sleepEndsAt = DateTime.now().add(duration);
    _sleepTimer = Timer(duration, () {
      _sleepTimer = null;
      _sleepEndsAt = null;
      _player.pause();
      notifyListeners();
    });
    notifyListeners();
  }

  /// Spegni alla fine del brano in corso.
  void sleepAtEndOfTrack() {
    cancelSleepTimer();
    _sleepAtTrackEnd = true;
    notifyListeners();
  }

  /// Annulla il timer di spegnimento (sia a tempo sia a fine brano).
  void cancelSleepTimer() {
    _sleepTimer?.cancel();
    _sleepTimer = null;
    _sleepEndsAt = null;
    _sleepAtTrackEnd = false;
    notifyListeners();
  }

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
    if (!(current?.isLive ?? false) && _player.position > const Duration(seconds: 3)) {
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
    final item = current;
    if (item != null) {
      if (_shuffle) {
        _queue = _shuffledFrom(item);
        _index = 0;
      } else {
        _queue = _original;
        _index = _queue.indexWhere((t) => t.qualifiedId == item.qualifiedId);
        if (_index < 0) _index = 0;
      }
    }
    notifyListeners();
  }

  Future<void> _onPlayerState(PlayerState state) async {
    notifyListeners();
    if (state.processingState != ProcessingState.completed) return;
    // Timer di spegnimento "a fine brano": ferma qui invece di avanzare.
    if (_sleepAtTrackEnd) {
      _sleepAtTrackEnd = false;
      await _player.pause();
      await _player.seek(Duration.zero);
      notifyListeners();
      return;
    }
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
    _sleepTimer?.cancel();
    _stateSub.cancel();
    _player.dispose();
    super.dispose();
  }
}
