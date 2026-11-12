import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'player_screen.dart';
import 'playlist_screen.dart';
import 'podcast_detail_screen.dart';

/// La libreria: cronologia, playlist, radio salvate e podcast seguiti.
/// I brani Audius della cronologia e delle playlist si riproducono; le altre
/// fonti per ora si mostrano soltanto.
class LibraryScreen extends ConsumerWidget {
  const LibraryScreen({super.key});

  Future<void> _refresh(WidgetRef ref) async {
    ref.invalidate(libraryProvider);
    ref.invalidate(collectionsProvider);
    ref.invalidate(downloadsProvider);
    await Future.wait([
      ref.read(libraryProvider.future).catchError((_) => LibraryData(
            history: const [],
            stations: const [],
            podcasts: const [],
          )),
      ref.read(collectionsProvider.future).catchError((_) => <Playlist>[]),
      ref.read(downloadsProvider.future).catchError((_) => <DownloadedTrack>[]),
    ]);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final library = ref.watch(libraryProvider);
    final collections = ref.watch(collectionsProvider);
    final downloads = ref.watch(downloadsProvider).valueOrNull ?? const <DownloadedTrack>[];

    return RefreshIndicator(
      color: kSolcoLime,
      backgroundColor: kSolcoNavyCard,
      onRefresh: () => _refresh(ref),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          // I brani scaricati funzionano anche offline: li mostriamo sempre, in cima.
          _DownloadsSection(downloads: downloads),
          ...library.when(
            loading: () => const [
              Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: CircularProgressIndicator(color: kSolcoLime)),
              ),
            ],
            error: (err, _) => const [
              _InlineNotice(
                text:
                    'La libreria online non è raggiungibile ora. I brani scaricati qui sopra funzionano comunque.',
              ),
            ],
            data: (data) {
              final playlists = collections.valueOrNull ?? const <Playlist>[];
              if (downloads.isEmpty && data.isEmpty && playlists.isEmpty) {
                return const [
                  _InlineNotice(
                    text:
                        'La tua libreria è vuota.\nAscolta qualcosa, crea una playlist o scarica un brano.',
                  ),
                ];
              }
              return [
                _HistorySection(history: data.history),
                _PlaylistSection(playlists: playlists),
                _StationsSection(stations: data.stations),
                _PodcastsSection(podcasts: data.podcasts),
              ];
            },
          ),
        ],
      ),
    );
  }
}

class _DownloadsSection extends ConsumerWidget {
  const _DownloadsSection({required this.downloads});
  final List<DownloadedTrack> downloads;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (downloads.isEmpty) return const SizedBox.shrink();
    final items = downloads.map((d) => d.toPlayable()).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionHeader('Scaricati'),
        ...downloads.asMap().entries.map((entry) {
          final i = entry.key;
          final d = entry.value;
          return ListTile(
            leading: _Art(url: d.artworkUrl, icon: Icons.download_done),
            title: Text(d.title, maxLines: 1, overflow: TextOverflow.ellipsis),
            subtitle: Text(d.artist ?? d.sourceLabel,
                maxLines: 1, overflow: TextOverflow.ellipsis),
            trailing: IconButton(
              icon: const Icon(Icons.delete_outline, color: Colors.white38),
              onPressed: () async {
                final store = await ref.read(offlineStoreProvider.future);
                await store.delete(d.qualifiedId);
                ref.invalidate(downloadsProvider);
              },
            ),
            onTap: () {
              ref.read(playerProvider)?.playItems(items, i);
              _openPlayer(context);
            },
          );
        }),
      ],
    );
  }
}

class _InlineNotice extends StatelessWidget {
  const _InlineNotice({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
      child: Center(
        child: Text(text,
            textAlign: TextAlign.center, style: const TextStyle(color: Colors.white60)),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.title, {this.trailing});
  final String title;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 20, 8, 4),
      child: Row(
        children: [
          Expanded(
            child: Text(title,
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

class _HistorySection extends ConsumerWidget {
  const _HistorySection({required this.history});
  final List<HistoryEntry> history;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (history.isEmpty) return const SizedBox.shrink();
    final playable = history.where((e) => e.toPlayable() != null).toList();
    final items = playable.map((e) => e.toPlayable()!).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionHeader(
          'Cronologia',
          trailing: TextButton(
            onPressed: () => _confirmClear(context, ref),
            child: const Text('Svuota', style: TextStyle(color: Colors.white54)),
          ),
        ),
        ...history.take(30).map((entry) {
          final canPlay = entry.toPlayable() != null;
          return ListTile(
            leading: _Art(url: entry.artworkUrl),
            title: Text(entry.title, maxLines: 1, overflow: TextOverflow.ellipsis),
            subtitle: Text(
              entry.playCount > 1 ? '${entry.artistName} · ${entry.playCount} ascolti' : entry.artistName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: Icon(canPlay ? Icons.play_arrow : Icons.open_in_new,
                color: canPlay ? Colors.white70 : Colors.white24),
            onTap: () {
              if (!canPlay) {
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                  content: Text('Questa fonte si ascolta dal sito.'),
                ));
                return;
              }
              final startIndex =
                  playable.indexWhere((e) => e.qualifiedId == entry.qualifiedId);
              ref.read(playerProvider)?.playItems(items, startIndex < 0 ? 0 : startIndex);
              _openPlayer(context);
            },
          );
        }),
      ],
    );
  }

  Future<void> _confirmClear(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: kSolcoNavyCard,
        title: const Text('Svuotare la cronologia?'),
        content: const Text('Questa azione non si può annullare.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Annulla')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Svuota')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final api = await ref.read(apiProvider.future);
      await api.clearHistory();
      ref.invalidate(libraryProvider);
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Operazione non riuscita.')));
      }
    }
  }
}

class _PlaylistSection extends StatelessWidget {
  const _PlaylistSection({required this.playlists});
  final List<Playlist> playlists;
  @override
  Widget build(BuildContext context) {
    if (playlists.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionHeader('Playlist'),
        ...playlists.map((p) => ListTile(
              leading: const _Art(url: null, icon: Icons.queue_music),
              title: Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text('${p.items.length} brani'),
              trailing: const Icon(Icons.chevron_right, color: Colors.white38),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => PlaylistScreen(playlist: p)),
              ),
            )),
      ],
    );
  }
}

class _StationsSection extends ConsumerWidget {
  const _StationsSection({required this.stations});
  final List<SavedStation> stations;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (stations.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionHeader('Radio salvate'),
        ...stations.map((s) => ListTile(
              leading: _Art(url: s.artworkUrl, icon: Icons.radio),
              title: Text(s.name, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: s.country != null ? Text(s.country!) : null,
              onTap: () {
                ref.read(playerProvider)?.playItems([s.toPlayable()], 0);
                _openPlayer(context);
              },
              trailing: IconButton(
                icon: const Icon(Icons.delete_outline, color: Colors.white38),
                onPressed: () async {
                  final api = await ref.read(apiProvider.future);
                  try {
                    await api.unsaveStation(s.stationId);
                    ref.invalidate(libraryProvider);
                  } catch (_) {}
                },
              ),
            )),
      ],
    );
  }
}

class _PodcastsSection extends ConsumerWidget {
  const _PodcastsSection({required this.podcasts});
  final List<FollowedPodcast> podcasts;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (podcasts.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionHeader('Podcast seguiti'),
        ...podcasts.map((p) => ListTile(
              leading: _Art(url: p.artworkUrl, icon: Icons.podcasts),
              title: Text(p.title, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: p.author != null ? Text(p.author!) : null,
              onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                builder: (_) => PodcastDetailScreen(
                  podcastId: p.podcastId,
                  fallback: Podcast(
                      id: p.podcastId, title: p.title, author: p.author, artworkUrl: p.artworkUrl),
                ),
              )),
              trailing: IconButton(
                icon: const Icon(Icons.delete_outline, color: Colors.white38),
                onPressed: () async {
                  final api = await ref.read(apiProvider.future);
                  try {
                    await api.unfollowPodcast(p.podcastId);
                    ref.invalidate(libraryProvider);
                  } catch (_) {}
                },
              ),
            )),
      ],
    );
  }
}

class _Art extends StatelessWidget {
  const _Art({required this.url, this.icon = Icons.music_note});
  final String? url;
  final IconData icon;
  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: SizedBox(
        width: 48,
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

  Widget _fallback() => ColoredBox(color: kSolcoNavyCard, child: Icon(icon, color: kSolcoLime));
}

void _openPlayer(BuildContext context) {
  Navigator.of(context).push(MaterialPageRoute<void>(
    fullscreenDialog: true,
    builder: (_) => const PlayerScreen(),
  ));
}
