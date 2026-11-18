#!/usr/bin/env python3
# Aggiunge la firma di RELEASE al `android/app/build.gradle` generato da `flutter create`,
# leggendo le credenziali da `android/key.properties` (scritto dal workflow a partire dai GitHub
# Secrets). Idempotente: se la firma c'è già, non fa nulla. Pensato per il template Groovy di
# Flutter (build.gradle); se un giorno il template passa a Kotlin DSL (build.gradle.kts) va adeguato.
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

if "keystoreProperties" in src:
    print(f"{path}: firma già presente, salto.")
    sys.exit(0)

load = (
    "def keystoreProperties = new Properties()\n"
    "def keystorePropertiesFile = rootProject.file('key.properties')\n"
    "if (keystorePropertiesFile.exists()) {\n"
    "    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))\n"
    "}\n\n"
)
signing = (
    "    signingConfigs {\n"
    "        release {\n"
    "            storeFile file(keystoreProperties['storeFile'])\n"
    "            storePassword keystoreProperties['storePassword']\n"
    "            keyAlias keystoreProperties['keyAlias']\n"
    "            keyPassword keystoreProperties['keyPassword']\n"
    "        }\n"
    "    }\n"
)

if "android {" not in src:
    print(f"{path}: blocco `android {{` non trovato, impossibile applicare la firma.", file=sys.stderr)
    sys.exit(1)

# 1) carica key.properties prima del blocco android {}
src = src.replace("android {", load + "android {", 1)
# 2) dichiara signingConfigs.release come prima cosa dentro android {}
src = src.replace("android {", "android {\n" + signing, 1)
# 3) usa la firma release nel buildType release (il template mette la debug)
src = src.replace("signingConfig = signingConfigs.debug", "signingConfig = signingConfigs.release")
src = src.replace("signingConfig signingConfigs.debug", "signingConfig signingConfigs.release")

open(path, "w", encoding="utf-8").write(src)
print(f"{path}: firma di release aggiunta.")
