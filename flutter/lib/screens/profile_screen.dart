import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_state.dart';
import '../theme.dart';
import 'premium_screen.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider).valueOrNull;
    final pro = ref.watch(proStatusProvider).valueOrNull;
    final isPremium = pro?.active ?? false;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const SizedBox(height: 8),
        if (session != null) ...[
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(session.name.isEmpty ? session.email : session.name,
                        style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                    Text(session.email, style: const TextStyle(color: Colors.white54)),
                  ],
                ),
              ),
              if (isPremium)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                    color: kSolcoLime.withOpacity(0.15),
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: kSolcoLime.withOpacity(0.6)),
                  ),
                  child: const Text('PREMIUM',
                      style: TextStyle(color: kSolcoLime, fontWeight: FontWeight.w700, fontSize: 12)),
                ),
            ],
          ),
          const SizedBox(height: 20),
        ],
        _premiumCard(context, isPremium),
        const SizedBox(height: 24),
        if (session != null)
          OutlinedButton.icon(
            icon: const Icon(Icons.logout),
            label: const Text('Esci'),
            onPressed: () async {
              final api = await ref.read(apiProvider.future);
              await api.signOut();
              ref.invalidate(sessionProvider);
              ref.invalidate(proStatusProvider);
            },
          ),
      ],
    );
  }

  Widget _premiumCard(BuildContext context, bool isPremium) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.workspace_premium, color: kSolcoLime),
                const SizedBox(width: 10),
                Text(isPremium ? 'Sei Premium' : 'Passa a Premium',
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              isPremium
                  ? 'Grazie! Ascolto completo, in background e senza limiti. Gestisci il rinnovo dal tuo store.'
                  : 'Brani completi, niente limite mensile, download offline e ascolto a schermo spento.',
              style: const TextStyle(color: Colors.white70),
            ),
            const SizedBox(height: 14),
            FilledButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const PremiumScreen()),
              ),
              child: Text(isPremium ? 'Gestisci Premium' : 'Attiva Premium'),
            ),
          ],
        ),
      ),
    );
  }
}
