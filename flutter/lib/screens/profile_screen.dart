import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_state.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider).valueOrNull;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const SizedBox(height: 8),
        if (session != null) ...[
          Text(session.name.isEmpty ? session.email : session.name,
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
          Text(session.email, style: const TextStyle(color: Colors.white54)),
        ],
        const SizedBox(height: 24),
        const Text(
          'Questa è la prima versione dell\'app nativa. Libreria, playlist, '
          'offline e Premium arriveranno nei prossimi passi.',
          style: TextStyle(color: Colors.white70),
        ),
        const SizedBox(height: 24),
        OutlinedButton.icon(
          icon: const Icon(Icons.logout),
          label: const Text('Esci'),
          onPressed: () async {
            final api = await ref.read(apiProvider.future);
            await api.signOut();
            ref.invalidate(sessionProvider);
          },
        ),
      ],
    );
  }
}
