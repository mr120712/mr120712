import 'dart:ui' show ImageFilter;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';

import '../api/models.dart';
import '../api/solco_api.dart';
import '../player/player_controller.dart';
import '../state/app_state.dart';
import '../theme.dart';

/// Lettore a schermo intero (Now Playing): copertina grande, barra di avanzamento,
/// precedente/play/successivo, shuffle e ripetizione, coda e attribuzione.
class PlayerScreen extends ConsumerWidget {
  const PlayerScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final player = ref.watch(playerProvider);
    if (player == null) return const SizedBox.shrink();
    return AnimatedBuilder(
      animation: player,
      builder: (context, _) {
        final track = player.current;
        if (track == null) {
          return const Scaffold(body: Center(child: Text('Niente in riproduzione')));
        }
        return Scaffold(
          backgroundColor: kSolcoNavy,
          extendBodyBehindAppBar: true,
          appBar: AppBar(
            backgroundColor: Colors.transparent,
            leading: IconButton(
              icon: const Icon(Icons.keyboard_arrow_down),
              onPressed: () => Navigator.of(context).maybePop(),
            ),
            title: const Text('In riproduzione', style: TextStyle(fontSize: 15)),
            centerTitle: true,
            actions: [_DownloadAction(item: track)],
          ),
          body: Stack(
            children: [
              if (track.artworkUrl != null) _BlurredBackdrop(url: track.artworkUrl!),
              SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Column(
                children: [
                  const Spacer(),
                  AspectRatio(
                    aspectRatio: 1,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(16),
                      child: track.artworkUrl != null
                          ? CachedNetworkImage(
                              imageUrl: track.artworkUrl!,
                              fit: BoxFit.cover,
                              placeholder: (_, __) => const ColoredBox(color: kSolcoNavyCard),
                              errorWidget: (_, __, ___) => const _BigArtFallback(),
                            )
                          : const _BigArtFallback(),
                    ),
                  ),
                  const SizedBox(height: 28),
                  Text(
                    track.title,
                    maxLines: 2,
                    textAlign: TextAlign.center,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    track.subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Colors.white60, fontSize: 15),
                  ),
                  const SizedBox(height: 18),
                  track.isLive ? const _LiveBadge() : _SeekBar(player: player),
                  const SizedBox(height: 8),
                  _Controls(player: player),
                  const SizedBox(height: 2),
                  _SecondaryControls(player: player, isLive: track.isLive),
                  const Spacer(),
                  _Attribution(item: track),
                  if (player.queue.length > 1)
                    TextButton.icon(
                      icon: const Icon(Icons.queue_music, size: 20),
                      label: Text('Coda (${player.queue.length})'),
                      onPressed: () => _showQueue(context, player),
                    ),
                  const SizedBox(height: 8),
                ],
              ),
            ),
          ),
            ],
          ),
        );
      },
    );
  }

  void _showQueue(BuildContext context, PlayerController player) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: kSolcoNavyCard,
      showDragHandle: true,
      builder: (context) {
        final queue = player.queue;
        return ListView.builder(
          padding: const EdgeInsets.only(bottom: 16),
          itemCount: queue.length,
          itemBuilder: (context, i) {
            final t = queue[i];
            final isCurrent = i == player.index;
            return ListTile(
              dense: true,
              leading: Icon(
                isCurrent ? Icons.equalizer : Icons.music_note,
                color: isCurrent ? kSolcoLime : Colors.white38,
                size: 20,
              ),
              title: Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(t.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis),
              onTap: () {
                player.playItems(queue, i);
                Navigator.of(context).pop();
              },
            );
          },
        );
      },
    );
  }
}

class _SeekBar extends StatefulWidget {
  const _SeekBar({required this.player});
  final PlayerController player;
  @override
  State<_SeekBar> createState() => _SeekBarState();
}

class _SeekBarState extends State<_SeekBar> {
  double? _dragValue;

  String _fmt(Duration d) {
    final m = d.inMinutes.remainder(60).toString();
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<Duration?>(
      stream: widget.player.durationStream,
      builder: (context, durSnap) {
        final duration = durSnap.data ?? Duration.zero;
        return StreamBuilder<Duration>(
          stream: widget.player.positionStream,
          builder: (context, posSnap) {
            final position = posSnap.data ?? Duration.zero;
            final max = duration.inMilliseconds.toDouble();
            final current = _dragValue ??
                position.inMilliseconds.clamp(0, max <= 0 ? 0 : max.toInt()).toDouble();
            return Column(
              children: [
                SliderTheme(
                  data: SliderTheme.of(context).copyWith(
                    trackHeight: 3,
                    thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
                    overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
                    activeTrackColor: kSolcoLime,
                    thumbColor: kSolcoLime,
                    inactiveTrackColor: Colors.white24,
                  ),
                  child: Slider(
                    min: 0,
                    max: max <= 0 ? 1 : max,
                    value: max <= 0 ? 0 : current.clamp(0, max),
                    onChanged: max <= 0 ? null : (v) => setState(() => _dragValue = v),
                    onChangeEnd: max <= 0
                        ? null
                        : (v) {
                            widget.player.seek(Duration(milliseconds: v.round()));
                            setState(() => _dragValue = null);
                          },
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(_fmt(position), style: const TextStyle(color: Colors.white54, fontSize: 12)),
                      Text(_fmt(duration), style: const TextStyle(color: Colors.white54, fontSize: 12)),
                    ],
                  ),
                ),
              ],
            );
          },
        );
      },
    );
  }
}

class _Controls extends StatelessWidget {
  const _Controls({required this.player});
  final PlayerController player;

  @override
  Widget build(BuildContext context) {
    final repeatIcon = switch (player.repeatMode) {
      RepeatMode.none => Icons.repeat,
      RepeatMode.all => Icons.repeat,
      RepeatMode.one => Icons.repeat_one,
    };
    final repeatActive = player.repeatMode != RepeatMode.none;
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        IconButton(
          icon: Icon(Icons.shuffle, color: player.shuffleEnabled ? kSolcoLime : Colors.white54),
          onPressed: player.toggleShuffle,
          tooltip: 'Casuale',
        ),
        IconButton(
          iconSize: 40,
          icon: Icon(Icons.skip_previous, color: player.hasPrevious ? Colors.white : Colors.white24),
          onPressed: player.hasPrevious ? player.previous : null,
        ),
        StreamBuilder<PlayerState>(
          stream: player.playerStateStream,
          builder: (context, snapshot) {
            final state = snapshot.data;
            final playing = state?.playing ?? false;
            final loading = state?.processingState == ProcessingState.loading ||
                state?.processingState == ProcessingState.buffering;
            return Container(
              decoration: const BoxDecoration(color: kSolcoLime, shape: BoxShape.circle),
              child: IconButton(
                iconSize: 40,
                color: kSolcoNavy,
                icon: loading
                    ? const SizedBox(
                        width: 28,
                        height: 28,
                        child: CircularProgressIndicator(strokeWidth: 3, color: kSolcoNavy),
                      )
                    : Icon(playing ? Icons.pause : Icons.play_arrow),
                onPressed: player.togglePlay,
              ),
            );
          },
        ),
        IconButton(
          iconSize: 40,
          icon: Icon(Icons.skip_next, color: player.hasNext ? Colors.white : Colors.white24),
          onPressed: player.hasNext ? player.next : null,
        ),
        IconButton(
          icon: Icon(repeatIcon, color: repeatActive ? kSolcoLime : Colors.white54),
          onPressed: player.cycleRepeat,
          tooltip: 'Ripeti',
        ),
      ],
    );
  }
}

class _LiveBadge extends StatelessWidget {
  const _LiveBadge();
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: kSolcoChristmasRed.withOpacity(0.18),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: const BoxDecoration(color: kSolcoChristmasRed, shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          const Text('IN DIRETTA',
              style: TextStyle(color: Colors.white, fontSize: 12, letterSpacing: 1)),
        ],
      ),
    );
  }
}

class _Attribution extends StatelessWidget {
  const _Attribution({required this.item});
  final PlayableItem item;
  @override
  Widget build(BuildContext context) {
    final text = switch (item.playbackMode) {
      'audius' => 'Audius · Open Music License',
      'radio' => 'Radio in diretta · ${item.subtitle}',
      'podcast' => item.sourceLabel,
      _ => item.sourceLabel,
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(color: Colors.white38, fontSize: 11),
      ),
    );
  }
}

/// Pulsante "Scarica per offline" nel lettore. Appare solo per i brani scaricabili
/// (Audius/podcast, non live), e mostra una spunta se già scaricato.
class _DownloadAction extends ConsumerWidget {
  const _DownloadAction({required this.item});
  final PlayableItem item;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final downloadable =
        !item.isOffline && (item.playbackMode == 'audius' || item.playbackMode == 'podcast');
    if (!downloadable) return const SizedBox.shrink();

    final downloads = ref.watch(downloadsProvider).valueOrNull ?? const <DownloadedTrack>[];
    final already = downloads.any((d) => d.qualifiedId == item.qualifiedId);
    if (already) {
      return const Padding(
        padding: EdgeInsets.only(right: 12),
        child: Icon(Icons.download_done, color: kSolcoLime),
      );
    }
    return IconButton(
      icon: const Icon(Icons.download_outlined),
      tooltip: 'Scarica per offline',
      onPressed: () async {
        final messenger = ScaffoldMessenger.of(context);
        messenger.showSnackBar(const SnackBar(content: Text('Scarico…')));
        try {
          final store = await ref.read(offlineStoreProvider.future);
          await store.download(item);
          ref.invalidate(downloadsProvider);
          messenger.hideCurrentSnackBar();
          messenger.showSnackBar(const SnackBar(content: Text('Scaricato per offline.')));
        } catch (e) {
          messenger.hideCurrentSnackBar();
          messenger.showSnackBar(SnackBar(
            content: Text(e is SolcoApiException ? e.message : 'Download non riuscito.'),
          ));
        }
      },
    );
  }
}

class _BigArtFallback extends StatelessWidget {
  const _BigArtFallback();
  @override
  Widget build(BuildContext context) => const ColoredBox(
        color: kSolcoNavyCard,
        child: Icon(Icons.music_note, color: kSolcoLime, size: 72),
      );
}

/// Copertina sfocata come sfondo del lettore (la musica continua, nulla si ferma).
class _BlurredBackdrop extends StatelessWidget {
  const _BlurredBackdrop({required this.url});
  final String url;

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: Stack(
        fit: StackFit.expand,
        children: [
          ImageFiltered(
            imageFilter: ImageFilter.blur(sigmaX: 45, sigmaY: 45),
            child: CachedNetworkImage(
              imageUrl: url,
              fit: BoxFit.cover,
              placeholder: (_, __) => const ColoredBox(color: kSolcoNavy),
              errorWidget: (_, __, ___) => const ColoredBox(color: kSolcoNavy),
            ),
          ),
          DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [
                  kSolcoNavy.withOpacity(0.55),
                  kSolcoNavy.withOpacity(0.92),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Controlli secondari: timer di spegnimento e velocità (quest'ultima nascosta in diretta radio).
class _SecondaryControls extends StatelessWidget {
  const _SecondaryControls({required this.player, required this.isLive});
  final PlayerController player;
  final bool isLive;

  static String _fmtSpeed(double value) =>
      value == value.roundToDouble() ? value.toStringAsFixed(0) : value.toString();

  @override
  Widget build(BuildContext context) {
    final sleepOn = player.sleepTimerActive;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        TextButton.icon(
          icon: Icon(
            sleepOn ? Icons.bedtime : Icons.bedtime_outlined,
            size: 20,
            color: sleepOn ? kSolcoLime : Colors.white70,
          ),
          label: Text(
            sleepOn ? 'Timer attivo' : 'Spegni',
            style: TextStyle(color: sleepOn ? kSolcoLime : Colors.white70),
          ),
          onPressed: () => _showSleepMenu(context),
        ),
        if (!isLive) ...[
          const SizedBox(width: 10),
          TextButton.icon(
            icon: const Icon(Icons.speed, size: 20, color: Colors.white70),
            label: Text(
              '${_fmtSpeed(player.speed)}×',
              style: const TextStyle(color: Colors.white70),
            ),
            onPressed: () => _showSpeedMenu(context),
          ),
        ],
      ],
    );
  }

  void _showSleepMenu(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: kSolcoNavyCard,
      showDragHandle: true,
      builder: (sheet) {
        ListTile tile(String label, VoidCallback onTap, {bool danger = false}) => ListTile(
              title: Text(label, style: danger ? const TextStyle(color: kSolcoChristmasRed) : null),
              onTap: () {
                onTap();
                Navigator.of(sheet).pop();
              },
            );
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('Timer di spegnimento',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              ),
              for (final m in const [15, 30, 45, 60])
                tile('$m minuti', () => player.startSleepTimer(Duration(minutes: m))),
              tile('Alla fine del brano', player.sleepAtEndOfTrack),
              if (player.sleepTimerActive)
                tile('Annulla timer', player.cancelSleepTimer, danger: true),
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );
  }

  void _showSpeedMenu(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: kSolcoNavyCard,
      showDragHandle: true,
      builder: (sheet) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('Velocità di riproduzione',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              ),
              for (final v in const [0.75, 1.0, 1.25, 1.5, 2.0])
                ListTile(
                  title: Text('${_fmtSpeed(v)}×'),
                  trailing:
                      player.speed == v ? const Icon(Icons.check, color: kSolcoLime) : null,
                  onTap: () {
                    player.setSpeed(v);
                    Navigator.of(sheet).pop();
                  },
                ),
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );
  }
}
