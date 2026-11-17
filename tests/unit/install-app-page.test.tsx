// @polsia:user-owned — pagina /app: la versione e l'impronta del certificato dell'APK vengono da
// src/lib/android-app.ts, gli stessi valori che tests/unit/android-apk-certificates.test.ts confronta
// con il binario in public/solco.apk e con assetlinks.json: la pagina non può promettere una versione
// o un certificato diversi da quelli distribuiti.
// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import InstallAppPage, { metadata } from '@/app/(custom)/app/page';
import {
  ANDROID_APP_CERT_SHA256,
  ANDROID_APP_PACKAGE,
  ANDROID_APP_VERSION,
} from '@/lib/android-app';
import { IOS_APP_VERSION, IOS_IPA_DOWNLOAD_NAME, IOS_IPA_PUBLIC_PATH } from '@/lib/ios-app';
import { siteUrl } from '@/lib/site';

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

describe('pagina /app', () => {
  it('metadata: titolo e canonical', () => {
    expect(metadata.title).toBe('Installa l’app');
    expect(metadata.alternates?.canonical).toBe('/app');
  });

  it("mostra versione, impronta del certificato e il download dell'APK", () => {
    const root = render(<InstallAppPage />);
    const android = root.querySelector('#android');
    expect(android?.textContent).toContain(`Versione ${ANDROID_APP_VERSION}`);
    expect(android?.textContent).toContain(`pacchetto ${ANDROID_APP_PACKAGE}`);
    expect(android?.querySelector('code')?.textContent).toBe(ANDROID_APP_CERT_SHA256);
    expect(android?.textContent).toContain('/.well-known/assetlinks.json');
    expect(android?.textContent).toContain('Hai già Solco 1.1.0 o 1.2.0?');
    const download = android?.querySelector('a[href="/solco.apk"]');
    expect(download?.getAttribute('download')).toBe('solco.apk');
  });

  it('iPhone: IPA pubblico da firmare con AltStore, poi il profilo senza installare nulla', () => {
    const root = render(<InstallAppPage />);
    const iphone = root.querySelector('#iphone');
    // Lato server l'app firmata da Solco non è ancora stata chiesta al server: nessun link finto.
    expect(iphone?.querySelector('a[href^="itms-services:"]')).toBeNull();
    const ipa = iphone?.querySelector(`a[href="${IOS_IPA_PUBLIC_PATH}"]`);
    expect(ipa?.getAttribute('download')).toBe(IOS_IPA_DOWNLOAD_NAME);
    const ipaUrl = encodeURIComponent(`${siteUrl}${IOS_IPA_PUBLIC_PATH}`);
    expect(iphone?.querySelector('a[href^="altstore://install?url="]')?.getAttribute('href')).toBe(
      `altstore://install?url=${ipaUrl}`,
    );
    expect(iphone?.querySelector('a[href^="sidestore://install?url="]')?.getAttribute('href')).toBe(
      `sidestore://install?url=${ipaUrl}`,
    );
    expect(iphone?.textContent).toContain(`Versione ${IOS_APP_VERSION}`);
    expect(iphone?.textContent).toContain('Oppure senza installare nulla');
    expect(iphone?.querySelector('a[href="/ios/solco.mobileconfig"]')).not.toBeNull();
  });
});
