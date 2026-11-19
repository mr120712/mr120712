// @polsia:user-owned — il progetto iOS NATIVO (ios/Solco.xcodeproj) deve restare allineato al sito:
// stesso identificativo (online.solcomusic.solco), stesso dominio ufficiale come base delle API; audio in
// background dichiarato. Lo script ios/build.sh e il workflow GitHub Actions che lo esegue su macOS
// devono conoscere le stesse modalità e non contenere segreti: certificati e chiavi li fornisce solo il
// proprietario, attraverso i segreti del repository. Dal novembre 2026 il sito distribuisce l'app Flutter
// (cartella flutter/); questo progetto nativo resta in repo come riferimento e conserva la sua versione
// (1.3.0/4), indipendente dalla versione dell'app Flutter pubblicata in /app.
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANDROID_APP_HOST, ANDROID_APP_PACKAGE } from '@/lib/android-app';

// Versione propria del progetto iOS nativo legacy (non quella dell'app Flutter distribuita).
const NATIVE_IOS_VERSION = '1.3.0';
const NATIVE_IOS_BUILD = 4;

const pbxproj = readFileSync('ios/Solco.xcodeproj/project.pbxproj', 'utf8');
const infoPlist = readFileSync('ios/Solco/Info.plist', 'utf8');
const workflow = readFileSync('.github/workflows/ios.yml', 'utf8');
const buildScript = readFileSync('ios/build.sh', 'utf8');
const exportOptions = readFileSync('ios/ExportOptions.template.plist', 'utf8');
const entitlements = readFileSync('ios/Solco/Solco.entitlements', 'utf8');

const MODES = ['check', 'ipa-unsigned', 'ipa', 'sign'];

describe('progetto iOS', () => {
  it("usa l'identificativo e il dominio del sito e la propria versione (Debug e Release)", () => {
    expect(pbxproj.match(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g)).toEqual(
      Array(2).fill(`PRODUCT_BUNDLE_IDENTIFIER = ${ANDROID_APP_PACKAGE};`),
    );
    expect(pbxproj.match(/SOLCO_API_BASE_URL = "[^"]*";/g)).toEqual(
      Array(2).fill(`SOLCO_API_BASE_URL = "https://${ANDROID_APP_HOST}";`),
    );
    expect(pbxproj.match(/CURRENT_PROJECT_VERSION = \d+;/g)).toEqual(
      Array(2).fill(`CURRENT_PROJECT_VERSION = ${NATIVE_IOS_BUILD};`),
    );
    expect(infoPlist).toContain(
      `<key>CFBundleShortVersionString</key>\n\t<string>${NATIVE_IOS_VERSION}</string>`,
    );
    expect(infoPlist).toContain(
      `<key>CFBundleVersion</key>\n\t<string>${NATIVE_IOS_BUILD}</string>`,
    );
  });

  it("dichiara l'audio in background, la categoria musica e la firma automatica senza team fisso", () => {
    expect(infoPlist).toMatch(/<key>UIBackgroundModes<\/key>\s*<array>\s*<string>audio<\/string>/);
    expect(infoPlist).toContain('<string>public.app-category.music</string>');
    expect(pbxproj).toContain('CODE_SIGN_STYLE = Automatic;');
    expect(pbxproj).not.toMatch(/DEVELOPMENT_TEAM = [A-Z0-9]{10};/);
  });

  it("collega l'app al dominio ufficiale (Associated Domains) in Debug e Release", () => {
    expect(pbxproj.match(/CODE_SIGN_ENTITLEMENTS = Solco\/Solco\.entitlements;/g)).toHaveLength(2);
    expect(entitlements).toContain('<key>com.apple.developer.associated-domains</key>');
    expect(entitlements).toContain(`<string>applinks:${ANDROID_APP_HOST}</string>`);
    expect(entitlements).toContain(`<string>webcredentials:${ANDROID_APP_HOST}</string>`);
  });

  it('lo script di build conosce tutte le modalità e non porta segreti', () => {
    for (const mode of MODES) {
      expect(buildScript).toContain(`\n  ${mode})`);
    }
    expect(buildScript).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(buildScript).toContain('ExportOptions.template.plist');
    expect(buildScript).not.toMatch(/-----BEGIN|AuthKey_[A-Z0-9]{6,}\.p8/);
  });

  it('il workflow iOS parte solo a mano, gira su macOS e usa lo script con i segreti del proprietario', () => {
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).not.toMatch(/\n\s+push:|\n\s+pull_request:|\n\s+schedule:/);
    expect(workflow).toContain('runs-on: macos-');
    expect(workflow).toMatch(/bash ios\/build\.sh "\$\{\{ inputs\.mode \}\}"/);
    expect(workflow).toContain('bash ios/build.sh ipa');
    // Esportazione Ad Hoc per l'installazione dal sito, accanto a quella per App Store Connect.
    expect(workflow).toContain('- ipa-adhoc');
    expect(workflow).toMatch(
      /SOLCO_IOS_EXPORT_METHOD: \$\{\{ inputs\.mode == 'ipa-adhoc' && 'ad-hoc' \|\| 'app-store-connect' \}\}/,
    );
    expect(buildScript).toContain('SOLCO_IOS_EXPORT_METHOD');
    for (const secret of [
      'APPLE_TEAM_ID',
      'APP_STORE_CONNECT_KEY_ID',
      'APP_STORE_CONNECT_ISSUER_ID',
      'APP_STORE_CONNECT_PRIVATE_KEY',
    ]) {
      expect(workflow).toContain(`\${{ secrets.${secret} }}`);
    }
    expect(workflow).toContain('ios/build/*.ipa');
  });

  it("l'esportazione è per App Store Connect con firma automatica e team dalla variabile", () => {
    expect(exportOptions).toContain('<string>__METHOD__</string>');
    expect(exportOptions).toContain('<string>automatic</string>');
    expect(exportOptions).toContain('__TEAM_ID__');
  });
});
