# Acquisti in-app (Premium) — guida di configurazione

L'app vende **Premium** come **abbonamento auto-rinnovabile** tramite gli store (Apple App Store /
Google Play). Il codice è già scritto; questa guida elenca i passi MANUALI che richiedono i tuoi
account sviluppatore (non automatizzabili da qui). Finché non li completi, la paywall mostra
"non disponibile" — nessun errore, ma nessun acquisto.

L'architettura: l'app avvia l'acquisto con il plugin ufficiale `in_app_purchase`, poi il backend di
Solco **ri-verifica lo stato presso lo store** (App Store Server API / Google Play Developer API),
lo lega all'account e concede l'accesso Pro. Il client non viene mai creduto sulla parola.

## 1. ID prodotto (identici su Apple e Google)

Definiti in `src/lib/business/iap/catalog.ts` del sito:

| productId                | Piano   | Periodo  |
|--------------------------|---------|----------|
| `solco_premium_monthly`  | premium | mensile  |
| `solco_premium_yearly`   | premium | annuale  |

Crea negli store ESATTAMENTE questi ID. Per aggiungere un piano, aggiungi la riga nel catalogo e
crea il prodotto corrispondente.

## 2. App Store Connect (iOS)

1. **Prodotti**: crea due **abbonamenti auto-rinnovabili** nello stesso *gruppo*, con gli ID della
   tabella. Imposta prezzi e descrizioni (Apple trattiene la sua quota e gestisce i listini).
2. **Chiave API** (per l'App Store Server API): *Users and Access → Integrations → App Store Connect
   API* (o *In-App Purchase*), genera una chiave, scarica il file `.p8`. Annota **Issuer ID** e
   **Key ID**.
3. **Apple Root CA G3**: scarica `AppleRootCA-G3.cer` da
   <https://www.apple.com/certificateauthority/>, convertilo in PEM
   (`openssl x509 -inform DER -in AppleRootCA-G3.cer -out AppleRootCA-G3.pem`) e usalo come
   `APPLE_IAP_ROOT_CA`.
4. **Notifiche** (opzionale ma consigliato): *App Information → App Store Server Notifications*,
   versione **V2**, URL di produzione e sandbox →
   `https://solcomusic.vercel.app/api/solco-pro/iap/apple/notifications`.

Variabili d'ambiente del backend (Vercel):

```
APPLE_IAP_BUNDLE_ID = com.tuonome.solco     # il bundle id dell'app iOS
APPLE_IAP_ISSUER_ID = <UUID issuer>
APPLE_IAP_KEY_ID    = <key id>
APPLE_IAP_PRIVATE_KEY = -----BEGIN PRIVATE KEY-----\n...contenuto .p8...\n-----END PRIVATE KEY-----
APPLE_IAP_ROOT_CA   = -----BEGIN CERTIFICATE-----\n...AppleRootCA-G3...\n-----END CERTIFICATE-----
```

(Le chiavi multilinea si possono incollare con `\n` al posto degli a capo.)

## 3. Google Play Console (Android)

1. **Prodotti**: *Monetize → Subscriptions*, crea due abbonamenti con gli ID della tabella e i
   relativi *base plan* (mensile/annuale) e prezzi.
2. **Service account**: in Google Cloud crea un service account, scarica la chiave **JSON**; in Play
   Console *Users and permissions* invita l'email del service account e dagli i permessi su
   *Financial data / Manage orders and subscriptions*. Abilita la **Google Play Android Developer
   API** nel progetto Cloud.
3. **Notifiche in tempo reale (RTDN)**: *Monetization setup → Real-time developer notifications*,
   crea un topic Pub/Sub e imposta l'endpoint push →
   `https://solcomusic.vercel.app/api/solco-pro/iap/google/notifications?secret=<SEGRETO>`.

Variabili d'ambiente del backend (Vercel):

```
GOOGLE_PLAY_PACKAGE_NAME = com.tuonome.solco      # il package name dell'app Android
GOOGLE_PLAY_SA_JSON      = { ...intero JSON del service account... }
# in alternativa al JSON intero:
# GOOGLE_PLAY_SA_CLIENT_EMAIL = sa@progetto.iam.gserviceaccount.com
# GOOGLE_PLAY_SA_PRIVATE_KEY  = -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
GOOGLE_PLAY_RTDN_SECRET  = <lo stesso segreto messo nella URL di push>
```

## 4. Opzioni comuni

```
IAP_ALLOW_SANDBOX = 1   # accetta acquisti sandbox/test (SOLO per i tester). In produzione: NON impostarlo.
```

Con `IAP_ALLOW_SANDBOX` assente, gli acquisti in ambiente Sandbox (Apple) o di test (Google) vengono
rifiutati: nessuna ricevuta di test concede Premium reale.

## 5. Lato app Flutter

`flutter pub get` tira dentro `in_app_purchase` e (su Android) la Play Billing Library.

- **Android**: `minSdkVersion` ≥ 21; il permesso `com.android.vending.BILLING` viene aggiunto dal
  plugin. Carica almeno una build firmata su una traccia di test e aggiungi account tester per
  provare gli acquisti.
- **iOS**: niente configurazione extra nel codice; per i test usa un **Sandbox Apple ID** (Impostazioni
  → App Store → Sandbox Account sul dispositivo) e una build TestFlight o da Xcode.

`kSolcoBaseUrl` in `lib/api/solco_api.dart` deve combaciare con `NEXT_PUBLIC_APP_URL` del deploy,
altrimenti le POST di verifica falliscono il controllo CSRF (same-origin).

## 6. Come funziona la verifica (per chi legge il codice)

1. L'app chiede `GET /api/solco-pro/iap/products` → prodotti + un `accountToken` (UUID legato
   all'utente). Passa quel token allo store come `applicationUserName` (Apple `appAccountToken`,
   Google `obfuscatedExternalAccountId`).
2. Dopo l'acquisto, l'app invia `POST /api/solco-pro/iap/verify { platform, productId, token }` dove
   `token` è il transactionId (Apple) o il purchaseToken (Google).
3. Il backend ri-legge lo stato dallo store, **verifica la firma JWS di Apple** (catena x5c →
   `APPLE_IAP_ROOT_CA`), controlla che `appAccountToken`/`obfuscatedExternalAccountId` corrisponda
   all'utente (anti-replay), che l'abbonamento non appartenga già a un altro account, e salva
   l'entitlement. Su Google conferma l'acquisto (acknowledge) entro 3 giorni.
4. Da quel momento `hasPremiumAccess()` e `requireSolcoPro()` riconoscono l'utente come Premium,
   esattamente come per Stripe/PayPal. Lo stato viene ri-verificato periodicamente e aggiornato dai
   webhook (rinnovi, disdette, rimborsi).
