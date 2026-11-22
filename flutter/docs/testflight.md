# Solco su TestFlight

Il workflow **Flutter (iOS)** in modalità **`testflight`** compila Solco, lo firma con la firma
automatica di Xcode e lo **carica su App Store Connect**: la build compare in TestFlight. I tester
interni (fino a 100 persone del tuo team App Store Connect) la installano **senza revisione Apple**;
per i tester esterni (fino a 10.000, anche con link pubblico) Apple fa una breve revisione beta.

## Una volta sola, su Apple

1. **Apple Developer Program** attivo (99 $/anno) sull'Apple ID del proprietario.
2. **Identificativo dell'app**: [developer.apple.com → Identifiers](https://developer.apple.com/account/resources/identifiers/list)
   → **+** → App IDs → App → Bundle ID esplicito **`online.solcomusic.solco`** (capability: nessuna
   in più; l'audio in background è nell'Info.plist).
3. **App in App Store Connect**: [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → My Apps
   → **+** → New App → piattaforma iOS, nome «Solco», bundle `online.solcomusic.solco`, SKU a piacere.
4. **Chiave API**: App Store Connect → Users and Access → **Integrations → App Store Connect API** →
   **+**, ruolo **Admin** (la firma automatica deve poter creare il certificato di distribuzione; con
   ruolo App Manager funziona solo se il certificato esiste già). Scarica il file `AuthKey_XXXX.p8`
   (si scarica UNA volta sola) e annota **Key ID** e **Issuer ID**.
5. **Team ID**: [developer.apple.com → Membership](https://developer.apple.com/account#MembershipDetailsCard),
   10 caratteri.

## I 4 GitHub Secrets

Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Nome | Valore |
|---|---|
| `APPLE_TEAM_ID` | il Team ID (10 caratteri) |
| `APP_STORE_CONNECT_KEY_ID` | il Key ID della chiave API |
| `APP_STORE_CONNECT_ISSUER_ID` | l'Issuer ID (un UUID) |
| `APP_STORE_CONNECT_PRIVATE_KEY` | il contenuto del file `.p8` (apri il file con un editor di testo e incolla tutto, righe `-----BEGIN/END PRIVATE KEY-----` comprese), oppure il file in base64 |

Non incollare mai questi valori in chat, in un issue o in un file del repository.

## Caricare una build

**Actions → Flutter (iOS) → Run workflow → `testflight`**. Il numero di build è
`<versionCode del pubspec>.<numero dell'esecuzione>` (per esempio `14.12`), quindi ogni caricamento è
unico anche con la stessa versione. Dopo il caricamento Apple elabora la build in 5–30 minuti.

## Distribuirla

- **Tester interni**: App Store Connect → Solco → **TestFlight → Internal Testing** → aggiungi le
  persone del team. Ricevono l'invito nell'app TestFlight, senza revisione.
- **Tester esterni / link pubblico**: TestFlight → **External Testing** → nuovo gruppo → aggiungi la
  build (la prima volta Apple chiede informazioni per la revisione beta) → attiva il **Public Link**.

## Errori frequenti

- *No profiles for 'online.solcomusic.solco' were found* / *No signing certificate* → la chiave API non
  è Admin, oppure l'App ID del passo 2 non esiste.
- *Cannot determine the Apple ID from Bundle ID* / *No suitable application records* → manca l'app
  del passo 3 in App Store Connect.
- *The bundle version must be higher than the previously uploaded version* → succede solo se una
  build con lo stesso numero è già stata caricata a mano: rilancia il workflow (il numero cresce).
