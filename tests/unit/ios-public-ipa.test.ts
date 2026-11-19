// @polsia:user-owned — l'IPA pubblico del sito (public/solco.ipa, scaricabile da /app e firmabile con
// AltStore o SideStore) deve essere davvero Solco nella versione che la pagina dichiara, restare fuori
// dal cancello UAM come l'APK, e i link di installazione devono puntare al file del sito.
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listZipEntries, readZipEntry } from '@/lib/business/ipa-archive';
import {
  altStoreInstallUrl,
  IOS_APP_BUNDLE_ID,
  IOS_APP_VERSION,
  IOS_IPA_DOWNLOAD_NAME,
  IOS_IPA_PUBLIC_PATH,
  sideStoreInstallUrl,
} from '@/lib/ios-app';
import { UAM_PUBLIC_ROOT_FILES } from '@/lib/security/uam';

const ipa = readFileSync(`public${IOS_IPA_PUBLIC_PATH}`);

describe('IPA pubblico', () => {
  it('è Solco nella versione dichiarata dalla pagina /app', () => {
    const entries = listZipEntries(ipa) ?? [];
    expect(entries.length).toBeGreaterThan(0);
    // Il bundle dell'app Flutter si chiama Runner.app (eseguibile Runner): troviamo il .app in modo
    // generico, senza fissare il nome, e controlliamo identificativo e versione nell'Info.plist.
    const info = entries.find((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry.name));
    expect(info).toBeDefined();
    const appDir = info ? info.name.slice('Payload/'.length, -'/Info.plist'.length) : '';
    const appName = appDir.replace(/\.app$/, '');
    const plist = info ? readZipEntry(ipa, info) : null;
    expect(plist?.includes(Buffer.from(IOS_APP_BUNDLE_ID, 'utf8'))).toBe(true);
    expect(plist?.includes(Buffer.from(IOS_APP_VERSION, 'utf8'))).toBe(true);
    expect(entries.some((entry) => entry.name === `Payload/${appDir}/${appName}`)).toBe(true);
    expect(IOS_IPA_DOWNLOAD_NAME).toBe(`Solco-${IOS_APP_VERSION}.ipa`);
  });

  it("resta fuori dal cancello UAM come l'APK", () => {
    expect(UAM_PUBLIC_ROOT_FILES.has(IOS_IPA_PUBLIC_PATH)).toBe(true);
    expect(UAM_PUBLIC_ROOT_FILES.has('/solco.apk')).toBe(true);
  });

  it('i link di AltStore e SideStore portano al file del sito', () => {
    const url = 'https://www.solcomusic.online/solco.ipa';
    expect(altStoreInstallUrl(url)).toBe(
      'altstore://install?url=https%3A%2F%2Fwww.solcomusic.online%2Fsolco.ipa',
    );
    expect(sideStoreInstallUrl(url)).toBe(
      'sidestore://install?url=https%3A%2F%2Fwww.solcomusic.online%2Fsolco.ipa',
    );
  });
});
