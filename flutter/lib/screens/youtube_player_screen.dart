import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:youtube_player_iframe/youtube_player_iframe.dart';

import '../api/models.dart';
import '../state/app_state.dart';
import '../theme.dart';

/// Riproduce un video YouTube con il PLAYER UFFICIALE (IFrame Player API in un
/// WebView): niente download né estrazione, conforme ai termini di YouTube.
/// Mostra i risultati come "coda" per passare al prossimo.
class YouTubePlayerScreen extends ConsumerStatefulWidget {
  const YouTubePlayerScreen({super.key, required this.videos, required this.startIndex});
  final List<YouTubeVideo> videos;
  final int startIndex;

  @override
  ConsumerState<YouTubePlayerScreen> createState() => _YouTubePlayerScreenState();
}

class _YouTubePlayerScreenState extends ConsumerState<YouTubePlayerScreen> {
  late final YoutubePlayerController _controller;
  late int _index;

  @override
  void initState() {
    super.initState();
    _index = widget.startIndex.clamp(0, widget.videos.length - 1);
    _controller = YoutubePlayerController.fromVideoId(
      videoId: widget.videos[_index].videoId,
      autoPlay: true,
      params: const YoutubePlayerParams(
        showControls: true,
        showFullscreenButton: true,
        strictRelatedVideos: true,
      ),
    );
    // Quando parte YouTube, metti in pausa il lettore audio (Audius/radio/podcast).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(playerProvider)?.player.pause();
    });
  }

  @override
  void dispose() {
    _controller.close();
    super.dispose();
  }

  void _play(int i) {
    setState(() => _index = i);
    _controller.loadVideoById(videoId: widget.videos[i].videoId);
  }

  @override
  Widget build(BuildContext context) {
    final current = widget.videos[_index];
    return YoutubePlayerScaffold(
      controller: _controller,
      aspectRatio: 16 / 9,
      builder: (context, player) {
        return Scaffold(
          appBar: AppBar(title: const Text('YouTube')),
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              player,
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Text(current.title,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text(current.channelTitle,
                    style: const TextStyle(color: Colors.white60, fontSize: 13)),
              ),
              if (widget.videos.length > 1)
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 8, 16, 4),
                  child: Text('Successivi',
                      style: TextStyle(fontWeight: FontWeight.w600, color: Colors.white70)),
                ),
              Expanded(
                child: ListView.builder(
                  itemCount: widget.videos.length,
                  itemBuilder: (context, i) {
                    final v = widget.videos[i];
                    final isCurrent = i == _index;
                    return ListTile(
                      leading: _Thumb(url: v.thumbnailUrl),
                      title: Text(v.title, maxLines: 2, overflow: TextOverflow.ellipsis),
                      subtitle: Text(v.channelTitle,
                          maxLines: 1, overflow: TextOverflow.ellipsis),
                      trailing: isCurrent
                          ? const Icon(Icons.equalizer, color: kSolcoLime, size: 20)
                          : null,
                      onTap: isCurrent ? null : () => _play(i),
                    );
                  },
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.url});
  final String? url;
  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: SizedBox(
        width: 72,
        height: 48,
        child: url != null
            ? CachedNetworkImage(
                imageUrl: url!,
                fit: BoxFit.cover,
                placeholder: (_, __) => const ColoredBox(color: kSolcoNavyCard),
                errorWidget: (_, __, ___) => _fallback(),
              )
            : _fallback(),
      ),
    );
  }

  Widget _fallback() => const ColoredBox(
        color: kSolcoNavyCard,
        child: Icon(Icons.ondemand_video, color: kSolcoLime),
      );
}
