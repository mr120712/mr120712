// @polsia:user-owned — pagina /app: la versione e l'impronta del certificato dell'APK vengono da
// src/lib/android-app.ts, gli stessi valori che tests/unit/android-apk-certificates.test.ts confronta
// con il binario in public/solco.apk e con assetlinks.json: la pagina non può promettere una versione
// o un certificato diversi da quelli distribuiti.
// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import InstallAppPage, { metadata } from '@/app/(custom)/app/page';
import { ANDROID_APP_CERT_SHA256, ANDROID_APP_VERSION } from '@/lib/android-app';

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
    expect(android?.querySelector('code')?.textContent).toBe(ANDROID_APP_CERT_SHA256);
    expect(android?.textContent).toContain('/.well-known/assetlinks.json');
    expect(android?.textContent).toContain('Hai già Solco 1.1.0?');
    const download = android?.querySelector('a[href="/solco.apk"]');
    expect(download?.getAttribute('download')).toBe('solco.apk');
  });
});
