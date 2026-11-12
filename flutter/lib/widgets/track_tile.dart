import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme.dart';

class TrackTile extends StatelessWidget {
  const TrackTile({super.key, required this.track, required this.onTap, this.playing = false});

  final AudiusTrack track;
  final VoidCallback onTap;
  final bool playing;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: onTap,
      leading: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: SizedBox(
          width: 48,
          height: 48,
          child: track.artworkUrl != null
              ? CachedNetworkImage(
                  imageUrl: track.artworkUrl!,
                  fit: BoxFit.cover,
                  placeholder: (_, __) => const ColoredBox(color: kSolcoNavyCard),
                  errorWidget: (_, __, ___) => const _ArtFallback(),
                )
              : const _ArtFallback(),
        ),
      ),
      title: Text(track.title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(track.artistName, maxLines: 1, overflow: TextOverflow.ellipsis),
      trailing: Icon(
        playing ? Icons.equalizer : Icons.play_arrow,
        color: playing ? kSolcoLime : Colors.white70,
      ),
    );
  }
}

class _ArtFallback extends StatelessWidget {
  const _ArtFallback();
  @override
  Widget build(BuildContext context) =>
      const ColoredBox(color: kSolcoNavyCard, child: Icon(Icons.music_note, color: kSolcoLime));
}
