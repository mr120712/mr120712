// @polsia:user-owned — chip dei mood della Home: URL (?mood=…) con router.replace, aria-pressed,
// "Tutto" e "Torna a Tutto" che riportano il feed di sempre.
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const location = { search: new URLSearchParams() };
  const setUrl = (url: string) => {
    location.search = new URLSearchParams(url.split('?')[1] ?? '');
    for (const listener of listeners) listener();
  };
  return {
    listeners,
    location,
    setUrl,
    // A stable router, like Next's: replace updates the URL the hooks read.
    router: { replace: vi.fn((url: string) => setUrl(url)) },
    apiFetch: vi.fn(),
    player: { currentTrack: null, status: 'idle', togglePlayback: vi.fn(), playTrack: vi.fn() },
  };
});

vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  };
  return {
    usePathname: () => '/',
    useRouter: () => mocks.router,
    useSearchParams: () => useSyncExternalStore(subscribe, () => mocks.location.search),
  };
});
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => mocks.player,
  trackStreamPath: () => null,
}));
vi.mock('next/image', () => ({ default: ({ alt }: { alt: string }) => <span>{alt}</span> }));

import {
  chipScrollTarget,
  FeedSectionLink,
  MoodChipGroup,
  MoodChips,
} from '@/components/custom/music/mood-chips';
import { HomeMoodSwitch } from '@/components/custom/music/mood-feed';

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount(node: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
}

function chip(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`chip ${label} missing`);
  return button;
}

function pressed(container: HTMLElement) {
  return [...container.querySelectorAll('button[aria-pressed="true"]')].map(
    (button) => button.textContent,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

beforeEach(() => {
  mocks.setUrl('/');
  mocks.router.replace.mockClear();
  // The mood feed stays loading: these tests are about which feed is shown.
  mocks.apiFetch.mockReset().mockReturnValue(new Promise(() => undefined));
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('MoodChips', () => {
  it('mostra "Tutto" e gli 8 mood come pulsanti con aria-pressed in un gruppo con legenda', async () => {
    const container = await mount(<MoodChips />);
    const group = container.querySelector('fieldset');
    const buttons = [...container.querySelectorAll('button')];

    expect(group?.querySelector('legend')?.textContent).toBe('Scegli un mood');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Tutto',
      'Relax',
      'Energia',
      'Allenamento',
      'Concentrazione',
      'Festa',
      'Malinconia',
      'Romantico',
      'Notte',
    ]);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-pressed')).toMatch(/^(true|false)$/);
    }
    expect(pressed(container)).toEqual(['Tutto']);
  });

  it('salva il mood nell’URL con router.replace, senza scorrere la pagina', async () => {
    const container = await mount(<MoodChips />);
    await click(chip(container, 'Relax'));

    expect(mocks.router.replace).toHaveBeenCalledWith('/?mood=relax', { scroll: false });
    expect(pressed(container)).toEqual(['Relax']);

    await click(chip(container, 'Notte'));
    expect(mocks.router.replace).toHaveBeenLastCalledWith('/?mood=notte', { scroll: false });
    expect(pressed(container)).toEqual(['Notte']);
  });

  it('mantiene gli altri parametri dell’URL', async () => {
    mocks.setUrl('/?ref=telegram');
    const container = await mount(<MoodChips />);
    await click(chip(container, 'Festa'));

    expect(mocks.router.replace).toHaveBeenCalledWith('/?ref=telegram&mood=festa', {
      scroll: false,
    });
  });

  it('legge il mood da un link condiviso e segue avanti/indietro del browser', async () => {
    mocks.setUrl('/?mood=romantico');
    const container = await mount(<MoodChips />);
    expect(pressed(container)).toEqual(['Romantico']);

    await act(async () => mocks.setUrl('/?mood=energia'));
    expect(pressed(container)).toEqual(['Energia']);

    await act(async () => mocks.setUrl('/'));
    expect(pressed(container)).toEqual(['Tutto']);
  });

  it('tratta un mood sconosciuto come "Tutto"', async () => {
    mocks.setUrl('/?mood=sconosciuto');
    const container = await mount(<MoodChips />);
    expect(pressed(container)).toEqual(['Tutto']);
  });

  it('ripremere il mood scelto torna a "Tutto"; ripremere "Tutto" non fa nulla', async () => {
    mocks.setUrl('/?mood=relax');
    const container = await mount(<MoodChips />);
    await click(chip(container, 'Relax'));

    expect(mocks.router.replace).toHaveBeenCalledWith('/', { scroll: false });
    expect(pressed(container)).toEqual(['Tutto']);

    await click(chip(container, 'Tutto'));
    expect(mocks.router.replace).toHaveBeenCalledTimes(1);
  });

  it('il segnaposto senza onSelect è inerte', async () => {
    const container = await mount(<MoodChipGroup selectedId={null} />);
    await click(chip(container, 'Relax'));

    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(pressed(container)).toEqual(['Tutto']);
  });
});

describe('HomeMoodSwitch', () => {
  const home = (
    <>
      <MoodChips />
      <HomeMoodSwitch className="feed">
        <p data-testid="default-feed">Feed di sempre</p>
      </HomeMoodSwitch>
    </>
  );

  it('con "Tutto" mostra il feed di sempre, con un mood il suo feed', async () => {
    const container = await mount(home);
    expect(container.querySelector('[data-testid="default-feed"]')).not.toBeNull();
    expect(container.querySelector('[data-mood]')).toBeNull();

    await click(chip(container, 'Concentrazione'));
    // Hidden, not unmounted: "Tutto" comes back instantly with its state.
    expect(
      container.querySelector('[data-testid="default-feed"]')?.closest('[hidden]'),
    ).not.toBeNull();
    expect(container.querySelector('.feed [data-mood="concentrazione"] h2')?.textContent).toBe(
      'Concentrazione',
    );
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/music/moods/concentrazione',
      expect.objectContaining({ schema: expect.anything() }),
    );

    await click(chip(container, 'Tutto'));
    expect(mocks.router.replace).toHaveBeenLastCalledWith('/', { scroll: false });
    expect(container.querySelector('[data-testid="default-feed"]')?.closest('[hidden]')).toBeNull();
    expect(container.querySelector('[data-mood]')).toBeNull();
    expect(container.querySelector('output[aria-live="polite"]')?.textContent).toBe(
      'Di nuovo tutto il feed della Home.',
    );
  });

  it('"Torna a Tutto" ripristina il feed e porta il focus sulla chip "Tutto"', async () => {
    mocks.setUrl('/?mood=malinconia');
    const container = await mount(home);
    // From a shared mood link the usual feed is not loaded in the background.
    expect(container.querySelector('[data-testid="default-feed"]')).toBeNull();
    const back = chip(container, 'Torna a Tutto');

    await click(back);
    expect(mocks.router.replace).toHaveBeenCalledWith('/', { scroll: false });
    expect(container.querySelector('[data-testid="default-feed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="default-feed"]')?.closest('[hidden]')).toBeNull();
    expect(document.activeElement).toBe(chip(container, 'Tutto'));
    expect(pressed(container)).toEqual(['Tutto']);
  });
  it('il feed di sempre conserva il suo stato dopo un giro su un mood', async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <button type="button" data-testid="counter" onClick={() => setCount((value) => value + 1)}>
          {`Contatore ${count}`}
        </button>
      );
    }
    const container = await mount(
      <>
        <MoodChips />
        <HomeMoodSwitch className="feed">
          <Counter />
        </HomeMoodSwitch>
      </>,
    );
    const counter = () => container.querySelector<HTMLButtonElement>('[data-testid="counter"]');

    await click(counter() as HTMLButtonElement);
    await click(counter() as HTMLButtonElement);
    expect(counter()?.textContent).toBe('Contatore 2');

    await click(chip(container, 'Relax'));
    expect(counter()?.closest('[hidden]')).not.toBeNull();
    await click(chip(container, 'Torna a Tutto'));

    expect(counter()?.closest('[hidden]')).toBeNull();
    expect(counter()?.textContent).toBe('Contatore 2');
  });
});

describe('FeedSectionLink', () => {
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  const home = (
    <>
      <FeedSectionLink targetId="tendenze">Classifiche</FeedSectionLink>
      <HomeMoodSwitch className="feed">
        <section id="tendenze">Classifiche della settimana</section>
      </HomeMoodSwitch>
    </>
  );

  function shortcut(container: HTMLElement) {
    const link = container.querySelector<HTMLAnchorElement>('a[href="#tendenze"]');
    if (!link) throw new Error('shortcut missing');
    return link;
  }

  it('con "Tutto" resta un normale link alla sezione', async () => {
    const container = await mount(home);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => shortcut(container).dispatchEvent(event));

    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('con un mood attivo torna a "Tutto" e poi scorre alla sezione, ora visibile', async () => {
    mocks.setUrl('/?mood=festa');
    const container = await mount(home);
    expect(document.getElementById('tendenze')).toBeNull();

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => shortcut(container).dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.router.replace).toHaveBeenCalledWith('/', { scroll: false });
    const target = document.getElementById('tendenze');
    expect(target?.closest('[hidden]')).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(target);
    // Like a native in-page link: the next Tab starts from the section, not from the shortcut.
    expect(document.activeElement).toBe(target);
    expect(target?.tabIndex).toBe(-1);
  });
});

describe('scorrimento della riga di chip', () => {
  // Fake layout: 9 chips 100px wide, 8px apart, inside a 300px row with 4px of padding.
  const CHIP = 100;
  const GAP = 8;
  const ROW = 300;
  const PADDING = 4;
  const CONTENT = PADDING * 2 + 9 * (CHIP + GAP) - GAP; // 972
  let scrollLeft = 0;
  let reducedMotion = false;
  // The row's computed scroll-padding-inline-start: '' (jsdom) falls back to 16px, as on touch.
  let scrollPadding = '';
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    scrollLeft = options.left ?? scrollLeft;
  });
  const originalScrollTo = Element.prototype.scrollTo;
  const isRow = (element: Element) =>
    element.firstElementChild?.hasAttribute('data-mood-chip') === true;
  const chipIndex = (element: HTMLElement) =>
    element.dataset.moodChip && element.parentElement
      ? [...element.parentElement.children].indexOf(element)
      : -1;

  beforeEach(() => {
    scrollLeft = 0;
    reducedMotion = false;
    scrollPadding = '';
    scrollTo.mockClear();
    const getComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return isRow(element)
        ? (Object.assign(Object.create(style), {
            scrollPaddingInlineStart: scrollPadding,
          }) as CSSStyleDeclaration)
        : style;
    });
    Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo;
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion,
      })),
    );
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      const index = chipIndex(this);
      return index < 0 ? 0 : PADDING + index * (CHIP + GAP);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return chipIndex(this) < 0 ? 0 : CHIP;
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return isRow(this) ? ROW : 0;
    });
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return isRow(this) ? CONTENT : 0;
    });
    vi.spyOn(Element.prototype, 'scrollLeft', 'get').mockImplementation(function (this: Element) {
      return isRow(this) ? scrollLeft : 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Element.prototype.scrollTo = originalScrollTo;
  });

  it('calcola lo spostamento minimo verso il bordo più vicino, con 16px di margine', () => {
    const row = { scrollLeft: 0, clientWidth: ROW, scrollWidth: CONTENT };
    // Fully visible: no scroll.
    expect(chipScrollTarget(row, { offsetLeft: 112, offsetWidth: CHIP })).toBeNull();
    // Cut off on the right: only as far as its right edge plus the padding.
    expect(chipScrollTarget(row, { offsetLeft: 220, offsetWidth: CHIP })).toBe(36);
    // Cut off on the left: its left edge minus the padding.
    expect(
      chipScrollTarget({ ...row, scrollLeft: 400 }, { offsetLeft: 328, offsetWidth: CHIP }),
    ).toBe(312);
    // Never past the ends of the row.
    expect(chipScrollTarget(row, { offsetLeft: 868, offsetWidth: CHIP })).toBe(CONTENT - ROW);
    expect(
      chipScrollTarget({ ...row, scrollLeft: 100 }, { offsetLeft: 4, offsetWidth: CHIP }),
    ).toBe(0);
    // Within the padding of an edge counts as covered (arrow and fade), except at the row's ends,
    // which have neither: there the row cannot move anyway.
    expect(
      chipScrollTarget({ ...row, scrollLeft: 30 }, { offsetLeft: 220, offsetWidth: CHIP }, 44),
    ).toBe(64);
    expect(chipScrollTarget(row, { offsetLeft: 4, offsetWidth: CHIP }, 44)).toBeNull();
  });

  it('con le frecce del mouse (44px di margine) la chip scelta finisce fuori dalla freccia', async () => {
    scrollPadding = '44px';
    const container = await mount(<MoodChips />);
    await click(chip(container, 'Energia'));

    // Its right edge (320px) ends 44px inside the row (64-364px), clear of the arrow and its fade;
    // with the 16px touch padding it would stop at 36px, under the arrow.
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 64, behavior: 'smooth' });
  });

  it('una chip con il focus, visibile ma sotto la freccia, scorre fuori dalla freccia', async () => {
    scrollPadding = '44px';
    const container = await mount(<MoodChips />);
    scrollLeft = 30;
    // "Energia" (220-320px) is fully inside 30-330px, so the browser would not scroll it: the
    // arrow over the last 36px of the row covers it.
    await act(async () => chip(container, 'Energia').focus());

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 64, behavior: 'smooth' });

    // Already clear: focusing it again does not move the row.
    scrollLeft = 64;
    await act(async () => chip(container, 'Relax').focus());
    await act(async () => chip(container, 'Energia').focus());
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('da un link condiviso mostra la chip scelta senza animazione', async () => {
    mocks.setUrl('/?mood=notte');
    await mount(<MoodChips />);

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: CONTENT - ROW, behavior: 'auto' });
  });

  it('scegliendo una chip tagliata scorre di poco e con animazione; se è visibile non scorre', async () => {
    const container = await mount(<MoodChips />);
    expect(scrollTo).not.toHaveBeenCalled();

    // "Energia" (220-320px) is cut off by the 300px row: 36px, not a jump to its left edge.
    await click(chip(container, 'Energia'));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 36, behavior: 'smooth' });

    // "Relax" (112-212px) is fully visible in 36-336px.
    await click(chip(container, 'Relax'));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('con movimento ridotto scorre senza animazione', async () => {
    reducedMotion = true;
    const container = await mount(<MoodChips />);
    await click(chip(container, 'Energia'));

    expect(scrollTo).toHaveBeenLastCalledWith({ left: 36, behavior: 'auto' });
  });

  it('quando la riga non entra mostra la freccia (solo puntatore) e la sfumatura verso le chip nascoste', async () => {
    const container = await mount(<MoodChips />);
    const row = container.querySelector('[data-mood-chip]')?.parentElement;
    const next = container.querySelector<HTMLButtonElement>('[data-mood-scroll="next"]');

    expect(row?.hasAttribute('data-overflow-end')).toBe(true);
    expect(row?.hasAttribute('data-overflow-start')).toBe(false);
    expect(container.querySelector('[data-mood-scroll="prev"]')).toBeNull();
    // Out of the tab order and of the accessibility tree: every chip is reachable with Tab.
    expect(next?.getAttribute('aria-hidden')).toBe('true');
    expect(next?.tabIndex).toBe(-1);

    await click(next as HTMLButtonElement);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: ROW * 0.8, behavior: 'smooth' });
    await act(async () => row?.dispatchEvent(new Event('scroll')));
    expect(row?.hasAttribute('data-overflow-start')).toBe(true);
    expect(container.querySelector('[data-mood-scroll="prev"]')).not.toBeNull();
  });
});
