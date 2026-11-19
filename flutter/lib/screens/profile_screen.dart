import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/solco_api.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'premi_screen.dart';
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
        if (session != null) ...[
          Card(
            child: ListTile(
              leading: const Icon(Icons.card_giftcard, color: kSolcoLime),
              title: const Text('Premi'),
              subtitle: const Text('Invita amici, ottieni Premium in regalo'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const PremiScreen()),
              ),
            ),
          ),
          const SizedBox(height: 16),
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
          const SizedBox(height: 28),
          const Divider(color: Colors.white12),
          const SizedBox(height: 8),
          Text('Account',
              style: TextStyle(
                  color: Colors.white.withOpacity(0.6), fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              style: TextButton.styleFrom(
                foregroundColor: Colors.redAccent,
                padding: EdgeInsets.zero,
              ),
              icon: const Icon(Icons.delete_forever),
              label: const Text('Elimina account'),
              onPressed: () => _confirmDeleteAccount(context, ref),
            ),
          ),
          const Text(
            "Elimini in modo definitivo il profilo, l'email, le playlist, i "
            'preferiti, la cronologia e tutti i dati collegati al tuo account Solco.',
            style: TextStyle(color: Colors.white38, fontSize: 12),
          ),
        ],
      ],
    );
  }

  /// Conferma e, se accettato, elimina definitivamente l'account (norme di
  /// Google Play / App Store: la cancellazione deve essere avviabile dall'app).
  Future<void> _confirmDeleteAccount(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text("Eliminare l'account?"),
        content: const Text(
          'Questa azione è definitiva e non si può annullare.\n\n'
          "Verranno eliminati il tuo profilo, l'email, le playlist, i preferiti, "
          'la cronologia di ascolto e tutti i dati collegati al tuo account Solco.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Annulla'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Elimina definitivamente'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      final api = await ref.read(apiProvider.future);
      await api.deleteAccount();
      ref.invalidate(sessionProvider);
      ref.invalidate(proStatusProvider);
      messenger.showSnackBar(
        const SnackBar(content: Text('Account eliminato.')),
      );
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(
              e is SolcoApiException ? e.message : 'Eliminazione non riuscita. Riprova.'),
        ),
      );
    }
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
