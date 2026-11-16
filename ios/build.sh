#!/usr/bin/env bash
# Compila l'app iOS di Solco con xcodebuild. Serve un Mac con Xcode 16 o successivo: nel repo gira sul
# runner macOS di GitHub Actions (workflow «iOS (IPA)», .github/workflows/ios.yml).
#
# Modalità:
#   check          compila per il simulatore, senza firma: verifica che il progetto compili.
#   ipa-unsigned   archivia per dispositivo senza firma e impacchetta build/Solco-unsigned.ipa.
#                  Un IPA senza firma NON si installa su nessun iPhone: va firmato con un certificato
#                  rilasciato dall'Apple Developer Program del proprietario (modalità `sign`, oppure
#                  `ipa` che firma direttamente).
#   ipa            archivia ed esporta build/Solco.ipa con firma automatica. Il metodo è
#                  SOLCO_IOS_EXPORT_METHOD: app-store-connect (predefinito: App Store e TestFlight),
#                  ad-hoc (installazione dal sito sui dispositivi registrati nell'account Apple) o
#                  development. Richiede SOLCO_APPLE_TEAM_ID; fuori da un Mac già autenticato in Xcode
#                  servono anche APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID e
#                  APP_STORE_CONNECT_KEY_PATH (chiave API .p8): Xcode crea certificati e profili da solo.
#   sign <ipa> <identità> <profilo.mobileprovision>
#                  firma su un Mac un IPA non firmato con un'identità del portachiavi
#                  (es. "Apple Distribution: Nome Cognome (TEAMID)") e il profilo di provisioning
#                  dell'app: produce build/Solco-signed.ipa.
#
# Nessuna modalità scarica o inventa certificati: li rilascia solo Apple al titolare dell'account.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:-check}"
project="$script_dir/Solco.xcodeproj"
scheme="Solco"
out="$script_dir/build"
archive="$out/Solco.xcarchive"
mkdir -p "$out"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild non trovato: questo script gira solo su un Mac con Xcode (o sul workflow GitHub Actions)." >&2
  exit 1
fi
# Niente `| head`: xcodebuild di Xcode 16 va in abort (SIGPIPE) se chi legge chiude il tubo prima.
xcode_version="$(xcodebuild -version)"
echo "${xcode_version%%$'\n'*}"

# Esegue xcodebuild salvando il log completo e mostrando solo errori ed esiti.
run_xcodebuild() {
  local log="$1"; shift
  local status=0
  xcodebuild "$@" >"$log" 2>&1 || status=$?
  grep -E "error:|\*\* (BUILD|ARCHIVE|EXPORT) " "$log" | head -n 80 || true
  if [[ $status -ne 0 ]]; then
    echo "xcodebuild è uscito con stato $status: log completo in $log" >&2
    tail -n 40 "$log" >&2
  fi
  return $status
}

case "$mode" in
  check)
    run_xcodebuild "$out/check.log" \
      -project "$project" -scheme "$scheme" -configuration Debug \
      -destination "generic/platform=iOS Simulator" -derivedDataPath "$out/DerivedData" \
      CODE_SIGNING_ALLOWED=NO build
    echo "Compilazione per simulatore riuscita."
    ;;

  ipa-unsigned)
    rm -rf "$archive" "$out/Payload" "$out/Solco-unsigned.ipa"
    run_xcodebuild "$out/archive.log" \
      -project "$project" -scheme "$scheme" -configuration Release \
      -destination "generic/platform=iOS" -archivePath "$archive" -derivedDataPath "$out/DerivedData" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" archive
    app="$archive/Products/Applications/Solco.app"
    [[ -d "$app" ]] || { echo "Archivio senza Solco.app: $archive" >&2; exit 1; }
    mkdir -p "$out/Payload"
    cp -R "$app" "$out/Payload/"
    (cd "$out" && zip -qr "Solco-unsigned.ipa" Payload)
    rm -rf "$out/Payload"
    /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Info.plist" | sed 's/^/identificativo: /'
    /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Info.plist" | sed 's/^/versione: /'
    echo "IPA non firmato: $out/Solco-unsigned.ipa (da firmare con un certificato Apple prima di installarlo)"
    ;;

  ipa)
    team="${SOLCO_APPLE_TEAM_ID:-}"
    if [[ -z "$team" ]]; then
      echo "Impostare SOLCO_APPLE_TEAM_ID con l'ID del team Apple Developer (10 caratteri)." >&2
      exit 2
    fi
    auth=(-allowProvisioningUpdates)
    if [[ -n "${APP_STORE_CONNECT_KEY_ID:-}" ]]; then
      for v in APP_STORE_CONNECT_ISSUER_ID APP_STORE_CONNECT_KEY_PATH; do
        [[ -n "${!v:-}" ]] || { echo "Manca $v accanto ad APP_STORE_CONNECT_KEY_ID." >&2; exit 2; }
      done
      auth+=(-authenticationKeyID "$APP_STORE_CONNECT_KEY_ID" -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID" -authenticationKeyPath "$APP_STORE_CONNECT_KEY_PATH")
    fi
    method="${SOLCO_IOS_EXPORT_METHOD:-app-store-connect}"
    case "$method" in
      app-store-connect|ad-hoc|development) ;;
      *) echo "SOLCO_IOS_EXPORT_METHOD deve essere app-store-connect, ad-hoc o development." >&2; exit 2 ;;
    esac
    echo "Metodo di esportazione: $method"
    sed -e "s/__TEAM_ID__/$team/" -e "s/__METHOD__/$method/" "$script_dir/ExportOptions.template.plist" >"$out/ExportOptions.plist"
    rm -rf "$archive" "$out/export" "$out/Solco.ipa"
    run_xcodebuild "$out/archive.log" \
      -project "$project" -scheme "$scheme" -configuration Release \
      -destination "generic/platform=iOS" -archivePath "$archive" -derivedDataPath "$out/DerivedData" \
      DEVELOPMENT_TEAM="$team" "${auth[@]}" archive
    run_xcodebuild "$out/export.log" \
      -exportArchive -archivePath "$archive" -exportOptionsPlist "$out/ExportOptions.plist" \
      -exportPath "$out/export" "${auth[@]}"
    cp "$out/export/Solco.ipa" "$out/Solco.ipa"
    codesign -dv --verbose=2 "$archive/Products/Applications/Solco.app" 2>&1 | grep -E "Authority|TeamIdentifier" || true
    echo "IPA firmato ($method): $out/Solco.ipa"
    ;;

  sign)
    unsigned="${2:-}"; identity="${3:-}"; profile="${4:-}"
    if [[ -z "$unsigned" || -z "$identity" || -z "$profile" ]]; then
      echo "Uso: bash ios/build.sh sign <ipa-non-firmato> <identità di firma> <profilo.mobileprovision>" >&2
      exit 2
    fi
    work="$out/resign"
    rm -rf "$work" "$out/Solco-signed.ipa"
    mkdir -p "$work"
    unzip -q "$unsigned" -d "$work"
    app="$work/Payload/Solco.app"
    [[ -d "$app" ]] || { echo "L'IPA non contiene Payload/Solco.app" >&2; exit 1; }
    cp "$profile" "$app/embedded.mobileprovision"
    security cms -D -i "$profile" >"$work/profile.plist"
    /usr/libexec/PlistBuddy -x -c "Print :Entitlements" "$work/profile.plist" >"$work/entitlements.plist"
    codesign --force --sign "$identity" --entitlements "$work/entitlements.plist" "$app"
    codesign --verify --deep --strict "$app"
    (cd "$work" && zip -qr "$out/Solco-signed.ipa" Payload)
    rm -rf "$work"
    echo "IPA firmato: $out/Solco-signed.ipa"
    ;;

  *)
    echo "Uso: bash ios/build.sh [check|ipa-unsigned|ipa|sign <ipa> <identità> <profilo>]" >&2
    exit 2
    ;;
esac
