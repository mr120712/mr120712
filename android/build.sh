#!/usr/bin/env bash
# Compila l'app Android (Trusted Web Activity) e produce l'APK distribuito dal sito (public/solco.apk)
# oppure un Android App Bundle da verificare localmente (solco.aab). Dopo la firma controlla che il
# certificato dell'APK sia pubblicato in public/.well-known/assetlinks.json: senza quell'accordo
# (Digital Asset Links) Android aprirebbe Solco con la barra del browser.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"
artifact="${1:-apk}"
if [[ "$artifact" != "apk" && "$artifact" != "aab" ]]; then
  echo "Uso: bash android/build.sh [apk|aab]" >&2
  exit 2
fi

# Versione dichiarata in app/build.gradle; il codice predefinito è quello dell'APK distribuito in /app.
gradle_file="$script_dir/app/build.gradle"
version_name="$(sed -n 's/^[[:space:]]*versionName "\([^"]*\)".*/\1/p' "$gradle_file" | head -n 1)"
default_version_code="$(sed -n "s/^def configuredVersionCode = .*?: '\([0-9]*\)'.*/\1/p" "$gradle_file" | head -n 1)"
if [[ -z "$version_name" || -z "$default_version_code" ]]; then
  echo "Non trovo versionName o il codice predefinito in app/build.gradle." >&2
  exit 1
fi
package_name="$(sed -n 's/^[[:space:]]*applicationId "\([^"]*\)".*/\1/p' "$gradle_file" | head -n 1)"

version_code="${SOLCO_ANDROID_VERSION_CODE:-$default_version_code}"
if [[ "$artifact" == "aab" ]]; then
  last_version_code="${SOLCO_ANDROID_LAST_VERSION_CODE:-}"
  version_code="${SOLCO_ANDROID_VERSION_CODE:-}"
  if [[ -z "$last_version_code" || -z "$version_code" ]]; then
    echo "Per un AAB verificare la Console e impostare SOLCO_ANDROID_LAST_VERSION_CODE e SOLCO_ANDROID_VERSION_CODE. Se non esiste una release precedente, usare 0 come ultimo codice solo dopo averlo verificato." >&2
    exit 2
  fi
  if [[ ! "$last_version_code" =~ ^(0|[1-9][0-9]*)$ || ! "$version_code" =~ ^[1-9][0-9]*$ ]]; then
    echo "I codici versione devono essere interi decimali non negativi; il nuovo codice deve essere positivo." >&2
    exit 2
  fi
  if (( 10#$last_version_code > 2100000000 || 10#$version_code > 2100000000 )); then
    echo "I codici versione non possono superare il limite Play di 2100000000." >&2
    exit 2
  fi
  if (( 10#$version_code <= 10#$last_version_code )); then
    echo "SOLCO_ANDROID_VERSION_CODE deve superare SOLCO_ANDROID_LAST_VERSION_CODE." >&2
    exit 2
  fi
fi
if [[ "$artifact" == "apk" && ! "$version_code" =~ ^[1-9][0-9]*$ ]]; then
  echo "SOLCO_ANDROID_VERSION_CODE deve essere un intero positivo." >&2
  exit 2
fi
export SOLCO_ANDROID_VERSION_CODE="$version_code"

sdk_path="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk_path" ]]; then
  echo "Impostare ANDROID_HOME o ANDROID_SDK_ROOT sul percorso dell'Android SDK." >&2
  exit 1
fi
build_tools="$sdk_path/build-tools/36.1.0"
if [[ ! -x "$build_tools/apksigner" ]]; then
  echo "Mancano gli Android Build Tools 36.1.0 in $sdk_path (sdkmanager \"build-tools;36.1.0\")." >&2
  exit 1
fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  if command -v java >/dev/null 2>&1; then
    # JAVA_HOME dal binario java sul PATH (JDK 17 o 21).
    export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
  else
    echo "Impostare JAVA_HOME su un JDK 17 o 21." >&2
    exit 1
  fi
fi

key_path="${SOLCO_ANDROID_SIGNING_KEY:-$script_dir/.keys/solco-release-key.jks}"
password_path="${SOLCO_ANDROID_SIGNING_PASSWORD_FILE:-$script_dir/.keys/keystore-password.txt}"
key_password_path="${SOLCO_ANDROID_SIGNING_KEY_PASSWORD_FILE:-$script_dir/.keys/key-password.txt}"
if [[ ! -f "$key_password_path" ]]; then
  key_password_path="$password_path"
fi
if [[ "$artifact" == "apk" && ( ! -f "$key_path" || ! -f "$password_path" ) ]]; then
  echo "Manca la chiave di firma locale o il relativo file password in android/.keys/." >&2
  exit 1
fi

export ANDROID_HOME="$sdk_path"
export ANDROID_SDK_ROOT="$sdk_path"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$script_dir/.android-user}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$script_dir/.gradle}"
mkdir -p "$ANDROID_USER_HOME" "$GRADLE_USER_HOME"

cd "$script_dir"
if [[ -n "${SOLCO_GRADLE_BIN:-}" ]]; then
  gradle_bin="$SOLCO_GRADLE_BIN"
else
  gradle_bin="$script_dir/gradlew"
fi

# Impronta SHA-256 (coppie maiuscole separate da due punti) del certificato che firma un APK.
apk_fingerprint() {
  "$build_tools/apksigner" verify --print-certs "$1" 2>/dev/null \
    | sed -n 's/^Signer #1 certificate SHA-256 digest: *\([0-9a-f]*\).*/\1/p' \
    | tr 'a-f' 'A-F' | sed 's/../&:/g; s/:$//'
}

if [[ "$artifact" == "apk" ]]; then
  out_dir="$script_dir/app/build/outputs/apk/release"
  output_apk="$repo_dir/public/solco.apk"
  rm -f "$out_dir"/app-release*.apk "$out_dir/solco-aligned.apk"
  "$gradle_bin" --no-daemon -p "$script_dir" assembleRelease

  if [[ -f "$out_dir/app-release.apk" ]]; then
    # Gradle ha trovato la chiave in android/.keys/ (signingConfig upload): l'APK è già allineato e firmato.
    cp "$out_dir/app-release.apk" "$output_apk"
  else
    unsigned_apk="$out_dir/app-release-unsigned.apk"
    aligned_apk="$out_dir/solco-aligned.apk"
    "$build_tools/zipalign" -f -p 4 "$unsigned_apk" "$aligned_apk"
    "$build_tools/apksigner" sign \
      --ks "$key_path" \
      --ks-key-alias "${SOLCO_ANDROID_SIGNING_ALIAS:-solco}" \
      --ks-pass "file:$password_path" \
      --key-pass "file:$key_password_path" \
      --out "$output_apk" \
      "$aligned_apk"
  fi
  "$build_tools/apksigner" verify --verbose "$output_apk" | sed -n '1,4p'

  badging="$("$build_tools/aapt2" dump badging "$output_apk" | sed -n '1p')"
  for expected in \
    "name='$package_name'" \
    "versionCode='$version_code'" \
    "versionName='$version_name'"; do
    if ! grep -Fq "$expected" <<<"$badging"; then
      echo "Metadato APK mancante o inatteso: $expected" >&2
      echo "$badging" >&2
      exit 1
    fi
  done

  # Il certificato dell'APK deve essere tra quelli pubblicati dal sito, altrimenti la TWA non è verificata.
  fingerprint="$(apk_fingerprint "$output_apk")"
  assetlinks="$repo_dir/public/.well-known/assetlinks.json"
  if [[ -z "$fingerprint" ]]; then
    echo "Impossibile leggere il certificato dell'APK." >&2
    exit 1
  fi
  if ! grep -Fq "\"$fingerprint\"" "$assetlinks"; then
    echo "Il certificato dell'APK ($fingerprint) non è in $assetlinks: aggiungilo prima di distribuire l'APK." >&2
    exit 1
  fi
  echo "APK firmato creato: $output_apk ($package_name $version_name, codice $version_code)"
  echo "Certificato SHA-256: $fingerprint (pubblicato in public/.well-known/assetlinks.json)"
else
  "$gradle_bin" --no-daemon -p "$script_dir" bundleRelease
  built_aab="$script_dir/app/build/outputs/bundle/release/app-release.aab"
  output_aab="$repo_dir/solco.aab"
  if [[ ! -f "$built_aab" ]]; then
    echo "Gradle non ha prodotto il bundle atteso: $built_aab" >&2
    exit 1
  fi
  cp "$built_aab" "$output_aab"

  if [[ -f "$key_path" && -f "$password_path" ]]; then
    jarsigner -verify "$output_aab" >/dev/null
    echo "Firma AAB verificata con la chiave di upload locale."
  else
    echo "AAB non firmato creato per verifica locale: $output_aab" >&2
    echo "AAB firmato non pronto: fornire la chiave di upload del proprietario in android/.keys/." >&2
  fi

  if [[ -n "${SOLCO_BUNDLETOOL_JAR:-}" ]]; then
    bundletool_command=(java -jar "$SOLCO_BUNDLETOOL_JAR")
  elif command -v bundletool >/dev/null 2>&1; then
    bundletool_command=(bundletool)
  else
    echo "bundletool non trovato: impostare SOLCO_BUNDLETOOL_JAR o installare bundletool per validare il bundle." >&2
    exit 1
  fi
  "${bundletool_command[@]}" validate --bundle="$output_aab"
  manifest_dump="$("${bundletool_command[@]}" dump manifest --bundle="$output_aab" --module=base)"
  for expected in \
    "package=\"$package_name\"" \
    "android:versionCode=\"$version_code\"" \
    "android:versionName=\"$version_name\"" \
    'android:minSdkVersion="24"' \
    'android:targetSdkVersion="36"'; do
    if ! grep -Fq "$expected" <<<"$manifest_dump"; then
      echo "Metadato AAB mancante o inatteso: $expected" >&2
      exit 1
    fi
  done
  echo "AAB validato localmente: $output_aab"
fi
