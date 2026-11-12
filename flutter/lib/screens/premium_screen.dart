import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:in_app_purchase/in_app_purchase.dart';

import '../billing/iap_controller.dart';
import '../state/app_state.dart';
import '../theme.dart';
import '../widgets/mini_player.dart';

/// Paywall: attiva Premium con un acquisto in-app (Apple App Store / Google Play).
class PremiumScreen extends ConsumerStatefulWidget {
  const PremiumScreen({super.key});

  @override
  ConsumerState<PremiumScreen> createState() => _PremiumScreenState();
}

class _PremiumScreenState extends ConsumerState<PremiumScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(iapControllerProvider)?.load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.watch(iapControllerProvider);
    final pro = ref.watch(proStatusProvider).valueOrNull;

    return Scaffold(
      appBar: AppBar(title: const Text('Solco Premium')),
      bottomNavigationBar: const MiniPlayer(),
      body: controller == null
          ? const Center(child: CircularProgressIndicator())
          : ListenableBuilder(
              listenable: controller,
              builder: (context, _) => _body(context, controller, pro?.active ?? false),
            ),
    );
  }

  Widget _body(BuildContext context, IapController controller, bool isActive) {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        if (isActive) _activeBanner(context),
        const SizedBox(height: 8),
        const Text(
          'Ascolto completo e in background, senza limiti.',
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 8),
        const Text(
          'Brani completi, niente limite mensile, download offline e riproduzione a schermo spento.',
          style: TextStyle(color: Colors.white70),
        ),
        const SizedBox(height: 24),
        if (controller.phase == IapPhase.loading)
          const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
        else if (controller.phase == IapPhase.unavailable)
          _unavailable(context, controller)
        else
          ...controller.products.map((p) => _planCard(context, controller, p)),
        if (controller.error != null) ...[
          const SizedBox(height: 12),
          Text(controller.error!, style: const TextStyle(color: kSolcoChristmasRed)),
        ],
        const SizedBox(height: 16),
        TextButton(
          onPressed: controller.pendingProductId != null ? null : controller.restore,
          child: const Text('Ripristina acquisti'),
        ),
        const SizedBox(height: 8),
        const Text(
          'L\'abbonamento si rinnova automaticamente finché non lo disdici dalle impostazioni del tuo '
          'account App Store o Google Play. Il pagamento è gestito dallo store.',
          style: TextStyle(color: Colors.white38, fontSize: 12),
        ),
      ],
    );
  }

  Widget _activeBanner(BuildContext context) {
    final pro = ref.watch(proStatusProvider).valueOrNull;
    final until = pro?.validUntil;
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: kSolcoLime.withOpacity(0.12),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: kSolcoLime.withOpacity(0.5)),
      ),
      child: Row(
        children: [
          const Icon(Icons.verified, color: kSolcoLime),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              until != null
                  ? 'Premium attivo · si rinnova il ${until.day}/${until.month}/${until.year}'
                  : 'Premium attivo',
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }

  Widget _unavailable(BuildContext context, IapController controller) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Column(
        children: [
          const Icon(Icons.storefront_outlined, size: 40, color: Colors.white38),
          const SizedBox(height: 12),
          const Text(
            'Gli acquisti in-app non sono disponibili su questo dispositivo in questo momento.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white70),
          ),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: controller.load, child: const Text('Riprova')),
        ],
      ),
    );
  }

  Widget _planCard(BuildContext context, IapController controller, ProductDetails product) {
    final pending = controller.pendingProductId == product.id;
    final anyPending = controller.pendingProductId != null;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(product.title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
            if (product.description.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(product.description, style: const TextStyle(color: Colors.white60)),
            ],
            const SizedBox(height: 14),
            Row(
              children: [
                Text(product.price, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                const Spacer(),
                FilledButton(
                  onPressed: anyPending ? null : () => controller.buy(product),
                  child: pending
                      ? const SizedBox(
                          height: 18,
                          width: 18,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black),
                        )
                      : const Text('Attiva'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
