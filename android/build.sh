#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"
artifact="${1:-apk}"
if [[ "$artifact" != "apk" && "$artifact" != "aab" ]]; then
  echo "Uso: bash android/build.sh [apk|aab]" >&2
  exit 2
fi

version_code="${SOLCO_ANDROID_VERSION_CODE:-1}"
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

sdk_path="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk_path" ]]; then
  echo "Impostare ANDROID_HOME o ANDROID_SDK_ROOT sul percorso dell'Android SDK." >&2
  exit 1
fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "Impostare JAVA_HOME su un JDK 17." >&2
  exit 1
fi

key_path="${SOLCO_ANDROID_SIGNING_KEY:-$script_dir/.keys/solco-release-key.jks}"
password_path="${SOLCO_ANDROID_SIGNING_PASSWORD_FILE:-$script_dir/.keys/keystore-password.txt}"
key_password_path="${SOLCO_ANDROID_SIGNING_KEY_PASSWORD_FILE:-$script_dir/.keys/key-password.txt}"
if [[ ! -f "$key_password_path" ]]; then
  key_password_path="$password_path"
fi
if [[ "$artifact" == "apk" && ! "$version_code" =~ ^[1-9][0-9]*$ ]]; then
  echo "SOLCO_ANDROID_VERSION_CODE deve essere un intero positivo." >&2
  exit 2
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

if [[ "$artifact" == "apk" ]]; then
  "$gradle_bin" --no-daemon -p "$script_dir" assembleRelease
  unsigned_apk="$script_dir/app/build/outputs/apk/release/app-release-unsigned.apk"
  aligned_apk="$script_dir/app/build/outputs/apk/release/solco-aligned.apk"
  output_apk="$repo_dir/solco.apk"
  "$sdk_path/build-tools/36.1.0/zipalign" -f -p 4 "$unsigned_apk" "$aligned_apk"
  "$sdk_path/build-tools/36.1.0/apksigner" sign \
    --ks "$key_path" \
    --ks-key-alias "${SOLCO_ANDROID_SIGNING_ALIAS:-solco}" \
    --ks-pass "file:$password_path" \
    --key-pass "file:$key_password_path" \
    --out "$output_apk" \
    "$aligned_apk"
  "$sdk_path/build-tools/36.1.0/apksigner" verify --verbose "$output_apk"
  echo "APK firmato creato: $output_apk"
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
    'package="app.solcomusic.solco"' \
    "android:versionCode=\"$version_code\"" \
    'android:versionName="1.0.0"' \
    'android:minSdkVersion="24"' \
    'android:targetSdkVersion="36"'; do
    if ! grep -Fq "$expected" <<<"$manifest_dump"; then
      echo "Metadato AAB mancante o inatteso: $expected" >&2
      exit 1
    fi
  done
  echo "AAB validato localmente: $output_aab"
fi
