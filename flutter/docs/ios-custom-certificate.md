# Firmare l'IPA di Solco con un certificato personalizzato

Il workflow **Flutter (iOS)** in modalità **`ipa-custom`** compila l'IPA senza firma e lo rifirma con
il **tuo** certificato: un `.p12` (certificato + chiave privata) e il `.mobileprovision` che lo
accompagna. Vanno bene quelli di un account Apple Developer o di un servizio di firma (per esempio
KravaSign). Lo script è `flutter/ios-signing/resign-ipa.sh`.

## Che cosa ti serve

| File | Dove si trova |
|---|---|
| `.p12` + la sua password | Apple Developer: esporta il certificato da Accesso Portachiavi. Servizio di firma: lo scarichi dall'ordine (KravaSign: pagina **Check Order**). |
| `.mobileprovision` | Nello stesso ordine/account, **insieme** al `.p12`: certificato e profilo devono essere della stessa coppia. |

## I tre Secrets

Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Nome | Valore |
|---|---|
| `IOS_SIGNING_CERT_P12_BASE64` | il `.p12` in base64 |
| `IOS_SIGNING_CERT_PASSWORD` | la password del `.p12` (se il `.p12` non ne ha, non creare questo Secret) |
| `IOS_PROVISIONING_PROFILE_BASE64` | il `.mobileprovision` in base64 |

Per ottenere il base64 su Mac (il risultato va negli appunti, non finisce in nessun file):

```bash
base64 -i certificato.p12 | pbcopy
base64 -i profilo.mobileprovision | pbcopy
```

Su Windows (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificato.p12")) | Set-Clipboard
```

Non incollare mai questi valori in chat, in un issue o in un file del repository.

## Avvio

**Actions → Flutter (iOS) → Run workflow**, modalità **`ipa-custom`**. Il log mostra profilo, team,
tipo (sviluppo, Ad Hoc o Enterprise), numero di dispositivi, scadenza e bundle. L'IPA firmato è
nell'artefatto `solco-flutter-ios-ipa-custom` come `Solco-custom.ipa`.

## Controlli ed errori

Lo script si ferma prima di firmare se:

- **il profilo è scaduto** → scaricane uno nuovo;
- **il certificato del `.p12` non è nel profilo** → `.p12` e `.mobileprovision` vengono da ordini o
  account diversi: usa la coppia scaricata insieme;
- **il `.p12` non si importa** → password sbagliata o file danneggiato;
- **il profilo copre un altro identificativo** (es. `com.altro.*`) → serve un profilo jolly (`*`) o per
  `online.solcomusic.solco`. Un profilo con un identificativo esplicito diverso fa cambiare il bundle
  dell'IPA in quello del profilo.

## Dove si installa

Solo sui dispositivi del profilo (sviluppo e Ad Hoc: gli UDID elencati; con KravaSign, il dispositivo
dell'ordine), oppure su tutti con un profilo Enterprise. Per questo l'IPA firmato **non** va in
`public/solco.ipa`: il sito pubblica l'IPA senza firma, che AltStore/SideStore firmano sul telefono di
chi lo installa.

## Prova senza certificati veri

La modalità **`check`** esegue `flutter/ios-signing/selftest.sh`: crea un certificato e un profilo
usa-e-getta e controlla sia la firma riuscita sia il rifiuto di un certificato estraneo al profilo.
