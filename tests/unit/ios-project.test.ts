// @polsia:user-owned — il progetto iOS (ios/Solco.xcodeproj) deve restare allineato all'app Android e al
// sito: stesso identificativo (online.solcomusic.solco), stesso dominio ufficiale come base delle API,
// stessa versione; audio in background dichiarato. Lo script ios/build.sh e il workflow GitHub Actions
// che lo esegue su macOS devono conoscere le stesse modalità e non contenere segreti: certificati e
// chiavi li fornisce solo il proprietario, attraverso i segreti del repository.
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_APP_HOST,
  ANDROID_APP_PACKAGE,
  ANDROID_APP_VERSION,
  ANDROID_APP_VERSION_CODE,
} from '@/lib/android-app';

const pbxproj = readFileSync('ios/Solco.xcodeproj/project.pbxproj', 'utf8');
const infoPlist = readFileSync('ios/Solco/Info.plist', 'utf8');
const workflow = readFileSync('.github/workflows/ios.yml', 'utf8');
const buildScript = readFileSync('ios/build.sh', 'utf8');
const exportOptions = readFileSync('ios/ExportOptions.template.plist', 'utf8');

const MODES = ['check', 'ipa-unsigned', 'ipa', 'sign'];

describe('progetto iOS', () => {
  it("usa l'identificativo, il dominio e la versione dell'app Android (Debug e Release)", () => {
    expect(pbxproj.match(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g)).toEqual(
      Array(2).fill(`PRODUCT_BUNDLE_IDENTIFIER = ${ANDROID_APP_PACKAGE};`),
    );
    expect(pbxproj.match(/SOLCO_API_BASE_URL = "[^"]*";/g)).toEqual(
      Array(2).fill(`SOLCO_API_BASE_URL = "https://${ANDROID_APP_HOST}";`),
    );
    expect(pbxproj.match(/CURRENT_PROJECT_VERSION = \d+;/g)).toEqual(
      Array(2).fill(`CURRENT_PROJECT_VERSION = ${ANDROID_APP_VERSION_CODE};`),
    );
    expect(infoPlist).toContain(
      `<key>CFBundleShortVersionString</key>\n\t<string>${ANDROID_APP_VERSION}</string>`,
    );
    expect(infoPlist).toContain(
      `<key>CFBundleVersion</key>\n\t<string>${ANDROID_APP_VERSION_CODE}</string>`,
    );
  });

  it("dichiara l'audio in background, la categoria musica e la firma automatica senza team fisso", () => {
    expect(infoPlist).toMatch(/<key>UIBackgroundModes<\/key>\s*<array>\s*<string>audio<\/string>/);
    expect(infoPlist).toContain('<string>public.app-category.music</string>');
    expect(pbxproj).toContain('CODE_SIGN_STYLE = Automatic;');
    expect(pbxproj).not.toMatch(/DEVELOPMENT_TEAM = [A-Z0-9]{10};/);
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
    expect(exportOptions).toContain('<string>app-store-connect</string>');
    expect(exportOptions).toContain('<string>automatic</string>');
    expect(exportOptions).toContain('__TEAM_ID__');
  });
});
