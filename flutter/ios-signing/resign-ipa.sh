#!/usr/bin/env bash
# @polsia:user-owned — firma l'IPA NON firmato di Solco con un certificato PERSONALIZZATO: il tuo .p12
# (certificato + chiave privata) e il .mobileprovision che lo accompagna, da un account Apple Developer
# o da un servizio di firma (per esempio KravaSign). Non ricompila l'app: rifirma il bundle già pronto.
# Gira su macOS (codesign, security). La password del .p12 arriva SOLO dalla variabile d'ambiente
# IOS_SIGNING_CERT_PASSWORD, mai come argomento (gli argomenti si vedono in `ps`).
#
# Uso: resign-ipa.sh <Solco-unsigned.ipa> <cert.p12> <profilo.mobileprovision> <uscita.ipa>
#
# Controlli prima di firmare (ognuno si ferma con un messaggio chiaro):
#   - il profilo non è scaduto;
#   - il certificato del .p12 è uno di quelli del profilo (la causa più comune di «app non installabile»);
#   - l'identificativo dell'app del profilo copre il bundle (online.solcomusic.solco). Un profilo con
#     un identificativo esplicito diverso fa cambiare il bundle dell'IPA in quello del profilo.
# L'IPA firmato si installa SOLO sui dispositivi del profilo (Ad Hoc / sviluppo: gli UDID elencati),
# o su tutti se il profilo è Enterprise. Non va pubblicato in public/solco.ipa.
set -euo pipefail

if [ $# -ne 4 ]; then
  echo "uso: $0 <unsigned.ipa> <cert.p12> <profile.mobileprovision> <out.ipa>" >&2
  exit 2
fi
IPA_IN=$1
P12=$2
PROFILE=$3
IPA_OUT=$4
: "${IOS_SIGNING_CERT_PASSWORD?manca IOS_SIGNING_CERT_PASSWORD (la password del .p12; può essere vuota)}"

for f in "$IPA_IN" "$P12" "$PROFILE"; do
  [ -s "$f" ] || { echo "ERRORE: file mancante o vuoto: $f" >&2; exit 2; }
done

WORK=$(mktemp -d "${RUNNER_TEMP:-/tmp}/solco-resign.XXXXXX")
KEYCHAIN="$WORK/sign.keychain-db"
KEYCHAIN_PW=$(openssl rand -base64 24)
OLD_KEYCHAINS=$(security list-keychains -d user | tr -d '"' | xargs)
cleanup() {
  # shellcheck disable=SC2086
  security list-keychains -d user -s $OLD_KEYCHAINS >/dev/null 2>&1 || true
  security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 1) Il profilo: contenuto firmato da Apple (CMS) → plist leggibile.
security cms -D -i "$PROFILE" > "$WORK/profile.plist" 2>/dev/null || {
  echo "ERRORE: il .mobileprovision non si legge (file danneggiato o non è un profilo di provisioning)." >&2
  exit 1
}

# 2) Portachiavi temporaneo con il .p12 (eliminato all'uscita, anche in caso di errore).
security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security set-keychain-settings -lut 3600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
if ! security import "$P12" -k "$KEYCHAIN" -P "$IOS_SIGNING_CERT_PASSWORD" -f pkcs12 -T /usr/bin/codesign >/dev/null 2>"$WORK/import.err"; then
  echo "ERRORE: il .p12 non si importa: password sbagliata o file non valido." >&2
  sed 's/^/  /' "$WORK/import.err" >&2
  exit 1
fi
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null
# shellcheck disable=SC2086
security list-keychains -d user -s "$KEYCHAIN" $OLD_KEYCHAINS
# Certificato intermedio Apple WWDR: serve a codesign per costruire la catena dei certificati Apple.
# Se non si scarica si prosegue: molte immagini macOS lo hanno già.
if curl -fsS --max-time 30 -o "$WORK/wwdr.cer" https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer; then
  security import "$WORK/wwdr.cer" -k "$KEYCHAIN" >/dev/null 2>&1 || true
fi
# Identità di firma nel portachiavi: «  1) <SHA-1> "<nome>"».
security find-identity -p codesigning "$KEYCHAIN" | sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) .*/\1/p' > "$WORK/identities.txt"

# 3) Unzip dell'IPA e lettura del bundle.
mkdir -p "$WORK/ipa"
unzip -q "$IPA_IN" -d "$WORK/ipa"
APP=$(find "$WORK/ipa/Payload" -maxdepth 1 -name '*.app' -type d | head -1)
[ -n "$APP" ] || { echo "ERRORE: nell'IPA manca Payload/*.app." >&2; exit 1; }

# 4) Controlli e diritti (entitlements) dal profilo, in Python (plistlib): scadenza, certificato,
#    identificativo dell'app. Scrive entitlements.plist e le variabili per la shell.
python3 - "$WORK/profile.plist" "$APP/Info.plist" "$WORK/identities.txt" "$WORK" <<'PY'
import datetime, fnmatch, hashlib, plistlib, sys
profile_path, info_path, ids_path, work = sys.argv[1:5]
with open(profile_path, 'rb') as f:
    p = plistlib.load(f)
with open(info_path, 'rb') as f:
    info = plistlib.load(f)
ids = {line.strip() for line in open(ids_path) if line.strip()}

def fail(msg):
    print(f"ERRORE: {msg}", file=sys.stderr)
    sys.exit(1)

name = p.get('Name', '?')
team = (p.get('TeamIdentifier') or [''])[0]
expires = p.get('ExpirationDate')
ent = p.get('Entitlements') or {}
app_id = ent.get('application-identifier', '')
if not team or not app_id.startswith(team + '.'):
    fail(f"profilo senza team o identificativo dell'app valido ({app_id!r}).")
if isinstance(expires, datetime.datetime):
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    exp = expires.replace(tzinfo=None)
    if exp <= now:
        fail(f"il profilo «{name}» è scaduto il {exp:%Y-%m-%d}: scaricane uno nuovo.")

# Il certificato del .p12 deve essere tra quelli del profilo (confronto per SHA-1).
profile_certs = {hashlib.sha1(c).hexdigest().upper() for c in p.get('DeveloperCertificates', [])}
match = sorted(ids & profile_certs)
if not match:
    fail("il certificato del .p12 non è tra quelli del profilo: usa il .p12 e il .mobileprovision "
         "dello STESSO ordine/account (con un servizio di firma: gli stessi file scaricati insieme).")

bundle = info.get('CFBundleIdentifier', '')
pattern = app_id[len(team) + 1:]
if '*' in pattern:
    if not fnmatch.fnmatchcase(bundle, pattern):
        fail(f"il profilo copre solo «{pattern}», non il bundle «{bundle}».")
    new_bundle = bundle
else:
    new_bundle = pattern  # profilo esplicito: il bundle diventa quello del profilo

# Diritti minimi e coerenti con il profilo: Solco non usa push, iCloud né altre capability.
out = {
    'application-identifier': f'{team}.{new_bundle}',
    'com.apple.developer.team-identifier': team,
    'get-task-allow': bool(ent.get('get-task-allow', False)),
}
groups = ent.get('keychain-access-groups')
if groups:
    out['keychain-access-groups'] = [f'{team}.{new_bundle}' if g.endswith('*') else g for g in groups]
with open(f'{work}/entitlements.plist', 'wb') as f:
    plistlib.dump(out, f)

if p.get('ProvisionsAllDevices'):
    kind, devices = 'Enterprise (tutti i dispositivi)', 'tutti'
else:
    kind = 'sviluppo' if out['get-task-allow'] else 'Ad Hoc'
    devices = str(len(p.get('ProvisionedDevices', [])))
with open(f'{work}/vars.sh', 'w') as f:
    f.write(f"IDENTITY={match[0]}\nNEW_BUNDLE={new_bundle}\nOLD_BUNDLE={bundle}\n")
print(f"Profilo:   {name}")
print(f"Team:      {team}")
print(f"Tipo:      {kind} · dispositivi: {devices}")
if isinstance(expires, datetime.datetime):
    print(f"Scade:     {expires:%Y-%m-%d}")
print(f"Bundle:    {new_bundle}" + ("" if new_bundle == bundle else f" (era {bundle})"))
PY
# shellcheck disable=SC1091
. "$WORK/vars.sh"

if [ "$NEW_BUNDLE" != "$OLD_BUNDLE" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $NEW_BUNDLE" "$APP/Info.plist"
fi

# 5) Firma: prima i framework e le librerie, poi l'app con i diritti del profilo.
rm -rf "$APP/_CodeSignature"
cp "$PROFILE" "$APP/embedded.mobileprovision"
if [ -d "$APP/PlugIns" ] && [ -n "$(ls -A "$APP/PlugIns")" ]; then
  echo "ERRORE: estensioni (PlugIns) non supportate da questo script." >&2
  exit 1
fi
if [ -d "$APP/Frameworks" ]; then
  find "$APP/Frameworks" -maxdepth 1 \( -name '*.framework' -o -name '*.dylib' \) -print0 |
    while IFS= read -r -d '' item; do
      codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" --timestamp=none "$item"
    done
fi
codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" --timestamp=none \
  --entitlements "$WORK/entitlements.plist" "$APP"
codesign --verify --strict --verbose=1 "$APP"
echo "Firmato:   $(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)"

# 6) Nuovo IPA.
mkdir -p "$(dirname "$IPA_OUT")"
IPA_OUT_ABS="$(cd "$(dirname "$IPA_OUT")" && pwd)/$(basename "$IPA_OUT")"
rm -f "$IPA_OUT_ABS"
(cd "$WORK/ipa" && zip -qry "$IPA_OUT_ABS" Payload)
echo "IPA:       $IPA_OUT_ABS ($(du -h "$IPA_OUT_ABS" | cut -f1))"
