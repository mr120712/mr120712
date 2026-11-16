// @polsia:user-owned — «Scarica il profilo» (pagina /app): il contesto iOS (Safari, altro browser,
// web app installata) e la resa: pulsante in Safari e da computer, pulsante con invito a Safari
// negli altri browser iOS, nota al posto del pulsante dentro la web app installata.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IOS_PROFILE_PATH,
  IosProfileDownload,
  iosProfileContext,
  isIosDevice,
  readIosProfileEnv,
} from '@/components/custom/install/ios-profile-download';

const SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
/** La web app aperta dalla schermata Home: niente "Version/" né "Safari/". */
const WEBCLIP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const CHROME_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const PAGE_URL = 'https://www.solcomusic.online/app';

describe('iosProfileContext', () => {
  it('riconosce iPhone, iPad (anche presentato come Mac col touch) e il resto', () => {
    expect(isIosDevice({ userAgent: SAFARI_UA })).toBe(true);
    expect(isIosDevice({ userAgent: IPAD_AS_MAC_UA, maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: IPAD_AS_MAC_UA, maxTouchPoints: 0 })).toBe(false);
    expect(isIosDevice({ userAgent: ANDROID_UA })).toBe(false);
  });

  it('Safari, altri browser iOS, web app installata, altro dispositivo', () => {
    expect(iosProfileContext({ userAgent: SAFARI_UA })).toBe('safari');
    expect(iosProfileContext({ userAgent: CHROME_IOS_UA })).toBe('other-browser');
    expect(iosProfileContext({ userAgent: WEBCLIP_UA, standalone: true })).toBe('installed');
    expect(iosProfileContext({ userAgent: SAFARI_UA, displayModeStandalone: true })).toBe(
      'installed',
    );
    // L'app installata vince anche su un browser "altro" (il contesto conta più dello UA).
    expect(iosProfileContext({ userAgent: CHROME_IOS_UA, standalone: true })).toBe('installed');
    expect(iosProfileContext({ userAgent: ANDROID_UA, displayModeStandalone: true })).toBe(
      'not-ios',
    );
    expect(iosProfileContext({ userAgent: '' })).toBe('not-ios');
  });
});

describe('<IosProfileDownload/>', () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  function setNavigator(userAgent: string, standalone?: boolean) {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: standalone });
  }

  async function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<IosProfileDownload pageUrl={PAGE_URL} />));
    return container;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'userAgent');
    Reflect.deleteProperty(navigator, 'standalone');
    document.body.replaceChildren();
  });

  it('legge il contesto dal browser (jsdom: nessun matchMedia)', () => {
    setNavigator(WEBCLIP_UA, true);
    expect(readIosProfileEnv()).toMatchObject({
      userAgent: WEBCLIP_UA,
      standalone: true,
      displayModeStandalone: false,
    });
  });

  it('in Safari su iPhone e da computer mostra il pulsante del profilo, senza note', async () => {
    setNavigator(SAFARI_UA);
    const safari = await mount();
    const link = safari.querySelector<HTMLAnchorElement>(`a[href="${IOS_PROFILE_PATH}"]`);
    expect(link?.textContent).toContain('Scarica il profilo');
    expect(safari.querySelector('output')).toBeNull();

    setNavigator(ANDROID_UA);
    const desktop = await mount();
    expect(desktop.querySelector(`a[href="${IOS_PROFILE_PATH}"]`)).not.toBeNull();
    expect(desktop.querySelector('output')).toBeNull();
  });

  it('dentro la web app installata sostituisce il pulsante con la nota (il profilo c’è già)', async () => {
    setNavigator(WEBCLIP_UA, true);
    const container = await mount();
    expect(container.querySelector(`a[href="${IOS_PROFILE_PATH}"]`)).toBeNull();
    const note = container.querySelector('output');
    expect(note?.textContent).toContain('già installato');
    expect(note?.textContent).toContain('www.solcomusic.online/app');
    expect(note?.textContent).not.toContain('https://');
  });

  it('in un browser iOS diverso da Safari tiene il pulsante e invita ad aprire Safari', async () => {
    setNavigator(CHROME_IOS_UA);
    const container = await mount();
    expect(container.querySelector(`a[href="${IOS_PROFILE_PATH}"]`)).not.toBeNull();
    expect(container.querySelector('output')?.textContent).toContain('Safari');
  });
});
