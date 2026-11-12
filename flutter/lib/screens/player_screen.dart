import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';

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
          appBar: AppBar(
            backgroundColor: Colors.transparent,
            leading: IconButton(
              icon: const Icon(Icons.keyboard_arrow_down),
              onPressed: () => Navigator.of(context).maybePop(),
            ),
            title: const Text('In riproduzione', style: TextStyle(fontSize: 15)),
            centerTitle: true,
          ),
          body: SafeArea(
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
                    track.artistName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Colors.white60, fontSize: 15),
                  ),
                  const SizedBox(height: 18),
                  _SeekBar(player: player),
                  const SizedBox(height: 8),
                  _Controls(player: player),
                  const Spacer(),
                  const _Attribution(),
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
              subtitle: Text(t.artistName, maxLines: 1, overflow: TextOverflow.ellipsis),
              onTap: () {
                player.playQueue(queue, i);
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

class _Attribution extends StatelessWidget {
  const _Attribution();
  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.only(bottom: 4),
      child: Text(
        'Audius · Open Music License',
        style: TextStyle(color: Colors.white38, fontSize: 11),
      ),
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
