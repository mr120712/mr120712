import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:in_app_purchase/in_app_purchase.dart';

import '../api/models.dart';
import '../api/solco_api.dart';

/// Fase della paywall.
enum IapPhase { idle, loading, ready, unavailable }

/// Gestisce gli acquisti in-app (abbonamenti auto-rinnovabili) con il plugin ufficiale
/// `in_app_purchase`. Il flusso: interroga i prodotti presso lo store, avvia l'acquisto legandolo
/// all'account (applicationUserName = token dal backend), ascolta l'esito e lo fa VERIFICARE dal
/// backend (che rilegge lo stato autorevole dallo store). Non decide da solo se l'utente è Premium.
class IapController extends ChangeNotifier {
  IapController(this._api, {this.onEntitlementChanged}) {
    _sub = _iap.purchaseStream.listen(
      _onUpdates,
      onError: (_) {
        error = 'Errore dallo store.';
        notifyListeners();
      },
    );
  }

  final SolcoApi _api;

  /// Chiamato dopo una verifica andata a buon fine (per ricaricare lo stato Premium).
  final VoidCallback? onEntitlementChanged;

  final InAppPurchase _iap = InAppPurchase.instance;
  StreamSubscription<List<PurchaseDetails>>? _sub;

  IapPhase phase = IapPhase.idle;
  List<ProductDetails> products = const [];
  String _accountToken = '';
  String? error;

  /// productId dell'acquisto in corso (per mostrare lo spinner sul pulsante giusto).
  String? pendingProductId;

  /// Carica disponibilità, catalogo del backend e dettagli prodotto dallo store.
  Future<void> load() async {
    phase = IapPhase.loading;
    error = null;
    notifyListeners();
    try {
      final available = await _iap.isAvailable();
      final catalog = await _api.getIapCatalog();
      _accountToken = catalog.accountToken;
      if (!available || !catalog.available || catalog.products.isEmpty) {
        products = const [];
        phase = IapPhase.unavailable;
        notifyListeners();
        return;
      }
      final ids = catalog.products.map((p) => p.productId).toSet();
      final response = await _iap.queryProductDetails(ids);
      products = response.productDetails;
      phase = products.isEmpty ? IapPhase.unavailable : IapPhase.ready;
    } on SolcoApiException catch (e) {
      error = e.message;
      phase = IapPhase.unavailable;
    } catch (_) {
      error = 'Impossibile caricare i piani.';
      phase = IapPhase.unavailable;
    }
    notifyListeners();
  }

  /// Avvia l'acquisto di un abbonamento, legandolo all'account Solco.
  Future<void> buy(ProductDetails product) async {
    error = null;
    pendingProductId = product.id;
    notifyListeners();
    final param = PurchaseParam(
      productDetails: product,
      applicationUserName: _accountToken.isEmpty ? null : _accountToken,
    );
    try {
      await _iap.buyNonConsumable(purchaseParam: param);
    } catch (_) {
      pendingProductId = null;
      error = 'Acquisto non avviato.';
      notifyListeners();
    }
  }

  /// Ripristina gli acquisti (per chi cambia dispositivo o reinstalla).
  Future<void> restore() async {
    error = null;
    notifyListeners();
    try {
      await _iap.restorePurchases();
    } catch (_) {
      error = 'Ripristino non riuscito.';
      notifyListeners();
    }
  }

  Future<void> _onUpdates(List<PurchaseDetails> purchases) async {
    for (final purchase in purchases) {
      switch (purchase.status) {
        case PurchaseStatus.pending:
          pendingProductId = purchase.productID;
          notifyListeners();
          break;
        case PurchaseStatus.error:
          pendingProductId = null;
          error = purchase.error?.message ?? 'Acquisto non riuscito.';
          notifyListeners();
          if (purchase.pendingCompletePurchase) await _iap.completePurchase(purchase);
          break;
        case PurchaseStatus.canceled:
          pendingProductId = null;
          notifyListeners();
          break;
        case PurchaseStatus.purchased:
        case PurchaseStatus.restored:
          await _verify(purchase);
          // Va SEMPRE completato, altrimenti lo store ripropone/rimborsa.
          if (purchase.pendingCompletePurchase) await _iap.completePurchase(purchase);
          break;
      }
    }
  }

  Future<void> _verify(PurchaseDetails purchase) async {
    final platform = Platform.isIOS ? 'apple' : 'google';
    // Apple: il transactionId. Google: il purchaseToken (= serverVerificationData su Android).
    final token = Platform.isIOS
        ? (purchase.purchaseID ?? '')
        : purchase.verificationData.serverVerificationData;
    if (token.isEmpty) {
      pendingProductId = null;
      error = 'Ricevuta mancante: riprova.';
      notifyListeners();
      return;
    }
    try {
      final result = await _api.verifyIapPurchase(
        platform: platform,
        productId: purchase.productID,
        token: token,
      );
      pendingProductId = null;
      if (result.ok && result.active) {
        error = null;
        onEntitlementChanged?.call();
      } else {
        error = _reasonMessage(result.reason);
      }
    } catch (_) {
      pendingProductId = null;
      error = 'Verifica non riuscita. Riprova.';
    }
    notifyListeners();
  }

  String _reasonMessage(String? reason) => switch (reason) {
        'account_mismatch' => 'Questo abbonamento è legato a un altro account.',
        'sandbox_not_allowed' => 'Acquisto di test non valido qui.',
        'unknown_product' => 'Prodotto non riconosciuto.',
        'not_configured' => 'Gli acquisti in-app non sono ancora attivi.',
        _ => 'Non è stato possibile confermare l’acquisto. Riprova.',
      };

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
