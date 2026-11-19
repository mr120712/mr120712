import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/solco_api.dart';
import '../state/app_state.dart';
import '../theme.dart';

/// «Premi»: codice invito (con link da copiare), amici iscritti, giorni di ascolto che contano,
/// fedeltà e Premium regalato. I dati vengono da /api/rewards; i progressi li calcola il server.
class PremiScreen extends ConsumerWidget {
  const PremiScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rewards = ref.watch(rewardsProvider);
    final api = ref.watch(apiProvider).valueOrNull;
    return Scaffold(
      appBar: AppBar(title: const Text('Premi')),
      body: rewards.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => _Error(
          message: e is SolcoApiException ? e.message : 'Impossibile caricare i premi.',
          onRetry: () => ref.invalidate(rewardsProvider),
        ),
        data: (r) {
          final link = api?.inviteLink(r.code) ?? '';
          return RefreshIndicator(
            onRefresh: () async => ref.refresh(rewardsProvider.future),
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _InviteCard(code: r.code, link: link),
                const SizedBox(height: 16),
                _StatRow(label: 'Amici iscritti', value: '${r.friendsJoined}'),
                _StatRow(label: 'Amici che contano', value: '${r.friendsQualified}'),
                const Divider(height: 28, color: Colors.white12),
                _StatRow(label: 'Giorni di ascolto validi', value: '${r.qualifyingDays}'),
                if (r.nextRewardIn > 0)
                  _StatRow(label: 'Al prossimo premio', value: '${r.nextRewardIn} giorni'),
                if (r.loyaltyMonths != null)
                  _StatRow(label: 'Mesi di fedeltà', value: '${r.loyaltyMonths}'),
                if (r.founderNumber != null)
                  _StatRow(label: 'Numero fondatore', value: '#${r.founderNumber}'),
                if (r.premiumUntil != null) ...[
                  const Divider(height: 28, color: Colors.white12),
                  _StatRow(
                    label: 'Premium attivo fino a',
                    value: _formatDate(r.premiumUntil!),
                    highlight: true,
                  ),
                ],
                const SizedBox(height: 24),
                const Text(
                  'Invita gli amici: quando si iscrivono e ascoltano, ricevi Premium in regalo. '
                  'Ascolta ogni giorno per avanzare verso il prossimo premio.',
                  style: TextStyle(color: Colors.white54, fontSize: 13),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  static String _formatDate(DateTime d) {
    final l = d.toLocal();
    final dd = l.day.toString().padLeft(2, '0');
    final mm = l.month.toString().padLeft(2, '0');
    return '$dd/$mm/${l.year}';
  }
}

class _InviteCard extends StatelessWidget {
  const _InviteCard({required this.code, required this.link});
  final String code;
  final String link;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: kSolcoNavyCard,
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Il tuo codice invito',
                style: TextStyle(color: Colors.white54, fontSize: 13)),
            const SizedBox(height: 6),
            SelectableText(
              code,
              style: const TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.bold,
                color: kSolcoLime,
                letterSpacing: 2,
              ),
            ),
            if (link.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(link, style: const TextStyle(color: Colors.white70, fontSize: 12)),
            ],
            const SizedBox(height: 14),
            FilledButton.icon(
              icon: const Icon(Icons.copy, size: 18),
              label: const Text('Copia link di invito'),
              onPressed: link.isEmpty
                  ? null
                  : () async {
                      final messenger = ScaffoldMessenger.of(context);
                      await Clipboard.setData(ClipboardData(text: link));
                      messenger.showSnackBar(
                        const SnackBar(content: Text('Link di invito copiato.')),
                      );
                    },
            ),
          ],
        ),
      ),
    );
  }
}

class _StatRow extends StatelessWidget {
  const _StatRow({required this.label, required this.value, this.highlight = false});
  final String label;
  final String value;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: Colors.white70)),
          Text(
            value,
            style: TextStyle(
              fontWeight: FontWeight.w600,
              color: highlight ? kSolcoLime : Colors.white,
            ),
          ),
        ],
      ),
    );
  }
}

class _Error extends StatelessWidget {
  const _Error({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Text(message, textAlign: TextAlign.center),
            ),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: onRetry, child: const Text('Riprova')),
          ],
        ),
      );
}
