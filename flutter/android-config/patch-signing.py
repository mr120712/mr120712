#!/usr/bin/env python3
# Aggiunge la firma di RELEASE al file Gradle dell'app generato da `flutter create`,
# leggendo le credenziali da `android/key.properties` (scritto dal workflow a partire dai GitHub
# Secrets). Idempotente: se la firma c'è già, non fa nulla.
#
# Supporta DUE template, perché Flutter è passato al Kotlin DSL per le nuove app (>= 3.29):
#   - build.gradle.kts  (Kotlin DSL, Flutter 3.29+)  → sintassi Kotlin
#   - build.gradle      (Groovy, Flutter <= 3.28)    → sintassi Groovy
# Rileva il tipo dal nome del file o dal contenuto e applica la trasformazione giusta.
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

if "keystoreProperties" in src:
    print(f"{path}: firma già presente, salto.")
    sys.exit(0)

if "android {" not in src:
    print(f"{path}: blocco `android {{` non trovato, impossibile applicare la firma.", file=sys.stderr)
    sys.exit(1)

is_kts = path.endswith(".kts") or 'signingConfigs.getByName("debug")' in src

if is_kts:
    # In Kotlin DSL gli import vanno in cima al file (prima di `plugins {}`): è lo snippet
    # ufficiale di firma di Flutter.
    imports = "import java.util.Properties\nimport java.io.FileInputStream\n\n"
    load = (
        "val keystoreProperties = Properties()\n"
        'val keystorePropertiesFile = rootProject.file("key.properties")\n'
        "if (keystorePropertiesFile.exists()) {\n"
        "    keystoreProperties.load(FileInputStream(keystorePropertiesFile))\n"
        "}\n\n"
    )
    signing = (
        "    signingConfigs {\n"
        '        create("release") {\n'
        '            storeFile = file(keystoreProperties["storeFile"] as String)\n'
        '            storePassword = keystoreProperties["storePassword"] as String\n'
        '            keyAlias = keystoreProperties["keyAlias"] as String\n'
        '            keyPassword = keystoreProperties["keyPassword"] as String\n'
        "        }\n"
        "    }\n"
    )
    if "import java.util.Properties" not in src:
        src = imports + src
else:
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

# 1) carica key.properties prima del blocco android {}
src = src.replace("android {", load + "android {", 1)
# 2) dichiara signingConfigs.release come prima cosa dentro android {}
src = src.replace("android {", "android {\n" + signing, 1)
# 3) usa la firma release nel buildType release (il template mette la debug)
if is_kts:
    src = src.replace(
        'signingConfig = signingConfigs.getByName("debug")',
        'signingConfig = signingConfigs.getByName("release")',
    )
else:
    src = src.replace("signingConfig = signingConfigs.debug", "signingConfig = signingConfigs.release")
    src = src.replace("signingConfig signingConfigs.debug", "signingConfig signingConfigs.release")

open(path, "w", encoding="utf-8").write(src)
print(f"{path}: firma di release aggiunta ({'Kotlin DSL' if is_kts else 'Groovy'}).")
