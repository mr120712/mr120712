import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/app_state.dart';
import '../theme.dart';

/// Le sezioni «Brani in evidenza» (self-hosted, dall'amministratore) in cima alla Home. Rende un
/// riquadro vuoto se non ce ne sono (o se non sono ancora arrivati), così non disturba la Home.
class FeaturedSections extends ConsumerWidget {
  const FeaturedSections({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sections = ref.watch(featuredSectionsProvider).valueOrNull ?? const <FeaturedSection>[];
    final api = ref.watch(apiProvider).valueOrNull;
    if (sections.isEmpty || api == null) return const SizedBox.shrink();
    final cookie = ref.watch(featuredCookieProvider).valueOrNull ?? const <String, String>{};
    final player = ref.watch(playerProvider);
    final currentId = player?.current?.qualifiedId;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final section in sections) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Text(
              section.title,
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
          ),
          SizedBox(
            height: 210,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              itemCount: section.items.length,
              separatorBuilder: (_, __) => const SizedBox(width: 12),
              itemBuilder: (context, i) {
                final track = section.items[i];
                return _FeaturedCard(
                  track: track,
                  coverUrl: track.artworkUrl == null ? null : api.featuredUrl(track.artworkUrl!),
                  coverHeaders: cookie,
                  playing: currentId == 'featured:${track.id}',
                  onTap: () => player?.playItems(
                    section.items.map((t) => t.toPlayable()).toList(),
                    i,
                  ),
                );
              },
            ),
          ),
        ],
      ],
    );
  }
}

class _FeaturedCard extends StatelessWidget {
  const _FeaturedCard({
    required this.track,
    required this.coverUrl,
    required this.coverHeaders,
    required this.playing,
    required this.onTap,
  });

  final FeaturedTrack track;
  final String? coverUrl;
  final Map<String, String> coverHeaders;
  final bool playing;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final artist = (track.artist == null || track.artist!.isEmpty) ? 'In evidenza' : track.artist!;
    return SizedBox(
      width: 150,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: AspectRatio(
                aspectRatio: 1,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    if (coverUrl != null)
                      CachedNetworkImage(
                        imageUrl: coverUrl!,
                        httpHeaders: coverHeaders.isEmpty ? null : coverHeaders,
                        fit: BoxFit.cover,
                        placeholder: (_, __) => const _CoverFallback(),
                        errorWidget: (_, __, ___) => const _CoverFallback(),
                      )
                    else
                      const _CoverFallback(),
                    if (playing)
                      Container(
                        color: Colors.black45,
                        alignment: Alignment.center,
                        child: const Icon(Icons.equalizer, color: kSolcoLime, size: 34),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              track.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            Text(
              artist,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: Colors.white54, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}

class _CoverFallback extends StatelessWidget {
  const _CoverFallback();

  @override
  Widget build(BuildContext context) => Container(
        color: kSolcoNavyCard,
        alignment: Alignment.center,
        child: const Icon(Icons.music_note, color: Colors.white24, size: 40),
      );
}
