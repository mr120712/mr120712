#!/usr/bin/env bash
# @polsia:user-owned — prova di resign-ipa.sh su macOS SENZA certificati veri: crea un certificato di
# firma usa-e-getta, un profilo finto (stesso formato CMS dei profili Apple) e una mini-app iOS, poi
#   1) firma con profilo jolly (TEAM.*) → deve riuscire, con i diritti e il profilo giusti;
#   2) firma con un .p12 che NON è nel profilo → deve fallire con il messaggio sul certificato.
# Il certificato di prova viene reso affidabile nel portachiavi di sistema del runner (sudo): il runner
# di GitHub è usa-e-getta. Non usare questo script sul tuo Mac.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d "${RUNNER_TEMP:-/tmp}/solco-selftest.XXXXXX")
TEAM=SOLCOTEST1
export IOS_SIGNING_CERT_PASSWORD=selftest-pw

make_identity() { # $1 = nome file, $2 = CN
  cat > "$T/$1.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $2
OU = $TEAM
O = Solco Selftest
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config "$T/$1.cnf" \
    -keyout "$T/$1.key" -out "$T/$1.pem" 2>/dev/null
  # Algoritmi «classici» (3DES/SHA1): `security import` di macOS non legge i .p12 AES di OpenSSL 3.
  openssl pkcs12 -export -inkey "$T/$1.key" -in "$T/$1.pem" -out "$T/$1.p12" \
    -passout "pass:$IOS_SIGNING_CERT_PASSWORD" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
  openssl x509 -in "$T/$1.pem" -outform der -out "$T/$1.der"
  sudo security add-trusted-cert -d -r trustRoot -p codeSign \
    -k /Library/Keychains/System.keychain "$T/$1.pem"
}
make_identity good 'Solco Selftest Signing'
make_identity other 'Solco Selftest Other'

# Profilo finto, jolly, firmato CMS come quelli di Apple.
python3 - "$T" "$TEAM" <<'PY'
import base64, datetime, plistlib, sys, uuid
t, team = sys.argv[1:3]
der = open(f'{t}/good.der', 'rb').read()
plistlib.dump({
    'Name': 'Solco Selftest Profile',
    'UUID': str(uuid.uuid4()).upper(),
    'TeamIdentifier': [team],
    'ExpirationDate': datetime.datetime.utcnow() + datetime.timedelta(days=2),
    'DeveloperCertificates': [der],
    'ProvisionedDevices': ['00008110-000000000000001E'],
    'Entitlements': {
        'application-identifier': f'{team}.*',
        'com.apple.developer.team-identifier': team,
        'get-task-allow': False,
        'keychain-access-groups': [f'{team}.*'],
    },
}, open(f'{t}/profile.plist', 'wb'))
PY
openssl smime -sign -binary -nodetach -outform der -signer "$T/good.pem" -inkey "$T/good.key" \
  -in "$T/profile.plist" -out "$T/profile.mobileprovision"

# Mini-app iOS (arm64) con un framework, impacchettata come l'IPA non firmato di Solco.
APP="$T/build/Payload/Runner.app"
mkdir -p "$APP/Frameworks/Flutter.framework"
printf 'int main(void){return 0;}\n' > "$T/main.c"
printf 'int solco_selftest(void){return 1;}\n' > "$T/lib.c"
xcrun -sdk iphoneos clang -arch arm64 -o "$APP/Runner" "$T/main.c"
xcrun -sdk iphoneos clang -arch arm64 -dynamiclib -install_name @rpath/Flutter.framework/Flutter \
  -o "$APP/Frameworks/Flutter.framework/Flutter" "$T/lib.c"
python3 - "$APP" <<'PY'
import plistlib, sys
app = sys.argv[1]
plistlib.dump({'CFBundleIdentifier': 'online.solcomusic.solco', 'CFBundleExecutable': 'Runner',
               'CFBundleName': 'Solco', 'CFBundlePackageType': 'APPL',
               'CFBundleShortVersionString': '0.0.0', 'CFBundleVersion': '1'},
              open(f'{app}/Info.plist', 'wb'))
plistlib.dump({'CFBundleIdentifier': 'io.flutter.flutter', 'CFBundleExecutable': 'Flutter',
               'CFBundlePackageType': 'FMWK', 'CFBundleVersion': '1'},
              open(f'{app}/Frameworks/Flutter.framework/Info.plist', 'wb'))
PY
(cd "$T/build" && zip -qry "$T/unsigned.ipa" Payload)

echo '== 1) profilo jolly + certificato giusto: deve riuscire =='
"$HERE/resign-ipa.sh" "$T/unsigned.ipa" "$T/good.p12" "$T/profile.mobileprovision" "$T/out/signed.ipa"
mkdir -p "$T/check" && unzip -q "$T/out/signed.ipa" -d "$T/check"
SIGNED="$T/check/Payload/Runner.app"
codesign --verify --strict "$SIGNED"
codesign -d --entitlements - --xml "$SIGNED" 2>/dev/null > "$T/ent.xml"
grep -q "$TEAM.online.solcomusic.solco" "$T/ent.xml" || { echo 'FALLITO: application-identifier' >&2; exit 1; }
cmp -s "$SIGNED/embedded.mobileprovision" "$T/profile.mobileprovision" || { echo 'FALLITO: profilo incorporato' >&2; exit 1; }
codesign -dvv "$SIGNED/Frameworks/Flutter.framework" 2>&1 | grep -q 'Authority=Solco Selftest Signing' ||
  { echo 'FALLITO: framework non firmato con la stessa identità' >&2; exit 1; }
echo 'OK: firmato, diritti e profilo corretti, framework firmato'

echo '== 2) certificato che non è nel profilo: deve fallire =='
if "$HERE/resign-ipa.sh" "$T/unsigned.ipa" "$T/other.p12" "$T/profile.mobileprovision" "$T/out/bad.ipa" 2> "$T/bad.err"; then
  echo 'FALLITO: ha firmato con un certificato estraneo al profilo' >&2
  exit 1
fi
grep -q 'non è tra quelli del profilo' "$T/bad.err" || { cat "$T/bad.err" >&2; echo 'FALLITO: messaggio inatteso' >&2; exit 1; }
echo 'OK: rifiutato con il messaggio giusto'
echo 'Selftest della firma personalizzata: superato.'
