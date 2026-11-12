import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_state.dart';
import '../theme.dart';

/// Barra del lettore sopra la navigazione: brano in corso, play/pausa, avanti.
class MiniPlayer extends ConsumerWidget {
  const MiniPlayer({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final player = ref.watch(playerProvider);
    if (player == null) return const SizedBox.shrink();
    return AnimatedBuilder(
      animation: player,
      builder: (context, _) {
        final track = player.current;
        if (track == null) return const SizedBox.shrink();
        return Material(
          color: kSolcoNavyCard,
          child: SafeArea(
            top: false,
            child: SizedBox(
              height: 60,
              child: Row(
                children: [
                  const SizedBox(width: 8),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: SizedBox(
                      width: 44,
                      height: 44,
                      child: track.artworkUrl != null
                          ? CachedNetworkImage(imageUrl: track.artworkUrl!, fit: BoxFit.cover)
                          : const ColoredBox(color: kSolcoNavy),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(track.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                        Text(track.artistName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: Colors.white54, fontSize: 12)),
                      ],
                    ),
                  ),
                  StreamBuilder<bool>(
                    stream: player.player.playingStream,
                    builder: (context, snapshot) {
                      final playing = snapshot.data ?? false;
                      return IconButton(
                        icon: Icon(playing ? Icons.pause : Icons.play_arrow),
                        color: kSolcoLime,
                        onPressed: player.togglePlay,
                      );
                    },
                  ),
                  IconButton(
                    icon: const Icon(Icons.skip_next),
                    color: player.hasNext ? Colors.white : Colors.white24,
                    onPressed: player.hasNext ? player.next : null,
                  ),
                  const SizedBox(width: 4),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
