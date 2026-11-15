// @polsia:user-owned — menu a tendina premium (SolcoSelect) su schermo largo: combobox ARIA con
// listbox in un portale, apertura e chiusura (clic, clic fuori, Esc, Tab), scelta col mouse e con la
// tastiera (frecce, Home/Fine, Invio, Spazio, iniziali), spunta rosa sull'opzione con
// aria-selected, notifica solo quando la scelta cambia davvero, griglia per le opzioni brevi.
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SolcoSelect, type SolcoSelectOption } from '@/components/custom/ui-premium/solco-select';

const COUNTRIES: SolcoSelectOption[] = [
  { value: 'IT', label: 'Italia' },
  { value: '', label: 'Tutto il mondo' },
  { value: 'FR', label: 'Francia' },
  { value: 'DE', label: 'Germania', disabled: true },
  { value: 'ES', label: 'Spagna' },
  { value: 'GB', label: 'Regno Unito' },
];

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function Harness({
  initial,
  onChange,
  options = COUNTRIES,
  columns,
  disabled,
}: {
  initial: string;
  onChange: (value: string) => void;
  options?: SolcoSelectOption[];
  columns?: number;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <SolcoSelect
        id="paese"
        label="Paese"
        placeholder="Scegli un paese"
        value={value}
        options={options}
        columns={columns}
        disabled={disabled}
        onValueChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
      <button type="button">Dopo</button>
    </div>
  );
}

async function mount(props: Parameters<typeof Harness>[0]) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Harness {...props} />));
  return container;
}

function trigger() {
  const element = document.querySelector<HTMLButtonElement>('[role="combobox"]');
  if (!element) throw new Error('combobox mancante');
  return element;
}

function listbox() {
  return document.querySelector<HTMLElement>('[role="listbox"]');
}

function options() {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

function option(label: string) {
  const found = options().find((node) => node.textContent === label);
  if (!found) throw new Error(`opzione ${label} mancante`);
  return found;
}

function activeLabel() {
  const id = trigger().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent : null;
}

async function press(target: HTMLElement, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** Radix restituisce il focus alla chiusura dopo un giro di setTimeout. */
async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openWithClick() {
  trigger().focus();
  await act(async () => trigger().click());
  // Radix registra l'ascolto dei clic "fuori" al giro successivo.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('SolcoSelect (pannello)', () => {
  it('chiuso: combobox con nome, valore scelto, nessun elenco nel documento', async () => {
    await mount({ initial: 'IT', onChange: vi.fn() });
    const button = trigger();
    expect(button.id).toBe('paese');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Paese');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(button.textContent).toBe('Italia');
    expect(button.getAttribute('data-state')).toBe('closed');
    expect(listbox()).toBeNull();
  });

  it('il clic apre l’elenco in un portale; la scelta ha aria-selected e la spunta rosa', async () => {
    const container = await mount({ initial: 'IT', onChange: vi.fn() });
    await openWithClick();
    const list = listbox();
    expect(list).not.toBeNull();
    // Nel portale (fuori dal contenitore): nessun overflow lo può tagliare.
    expect(container.contains(list)).toBe(false);
    expect(list?.getAttribute('aria-label')).toBe('Paese');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('data-state')).toBe('open');
    expect(trigger().getAttribute('aria-controls')).toBe(list?.id);
    expect(options().map((node) => node.textContent)).toEqual([
      'Italia',
      'Tutto il mondo',
      'Francia',
      'Germania',
      'Spagna',
      'Regno Unito',
    ]);
    expect(option('Italia').getAttribute('aria-selected')).toBe('true');
    expect(option('Francia').getAttribute('aria-selected')).toBe('false');
    expect(option('Germania').getAttribute('aria-disabled')).toBe('true');
    // Spunta solo sull'opzione scelta.
    expect(option('Italia').querySelectorAll('svg')).toHaveLength(1);
    expect(option('Francia').querySelectorAll('svg')).toHaveLength(0);
    // Il focus resta sul pulsante; l'opzione attiva è indicata da aria-activedescendant.
    expect(document.activeElement).toBe(trigger());
    expect(activeLabel()).toBe('Italia');
  });

  it('un clic su un’opzione la sceglie e chiude; riscegliere la stessa non notifica', async () => {
    const onChange = vi.fn();
    await mount({ initial: 'IT', onChange });
    await openWithClick();
    await act(async () => option('Tutto il mondo').click());
    expect(onChange).toHaveBeenCalledWith('');
    expect(listbox()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().textContent).toBe('Tutto il mondo');
    expect(document.activeElement).toBe(trigger());

    await openWithClick();
    await act(async () => option('Tutto il mondo').click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(listbox()).toBeNull();
  });

  it('un’opzione disattivata non si sceglie', async () => {
    const onChange = vi.fn();
    await mount({ initial: 'IT', onChange });
    await openWithClick();
    await act(async () => option('Germania').click());
    expect(onChange).not.toHaveBeenCalled();
    expect(listbox()).not.toBeNull();
  });

  it('un tocco fuori chiude senza cambiare la scelta', async () => {
    const onChange = vi.fn();
    const container = await mount({ initial: 'FR', onChange });
    await openWithClick();
    const outside = container.querySelector<HTMLButtonElement>('button:not([role])');
    await act(async () => {
      outside?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(listbox()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().textContent).toBe('Francia');
  });

  it('di nuovo il pulsante: chiude (non si riapre da solo)', async () => {
    await mount({ initial: 'FR', onChange: vi.fn() });
    await openWithClick();
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      trigger().click();
    });
    expect(listbox()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('Esc chiude senza cambiare e il focus resta sul pulsante', async () => {
    const onChange = vi.fn();
    await mount({ initial: 'FR', onChange });
    await openWithClick();
    await press(trigger(), 'Escape');
    expect(listbox()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it('tastiera: Freccia giù apre, le frecce saltano le disattivate, Home/Fine, Invio sceglie', async () => {
    const onChange = vi.fn();
    await mount({ initial: 'FR', onChange });
    trigger().focus();
    await press(trigger(), 'ArrowDown');
    expect(listbox()).not.toBeNull();
    expect(activeLabel()).toBe('Francia');
    await press(trigger(), 'ArrowDown');
    // Germania è disattivata: si passa direttamente a Spagna.
    expect(activeLabel()).toBe('Spagna');
    await press(trigger(), 'ArrowUp');
    expect(activeLabel()).toBe('Francia');
    await press(trigger(), 'End');
    expect(activeLabel()).toBe('Regno Unito');
    await press(trigger(), 'Home');
    expect(activeLabel()).toBe('Italia');
    // In fondo all'elenco la freccia non ricomincia da capo.
    await press(trigger(), 'ArrowUp');
    expect(activeLabel()).toBe('Italia');
    await press(trigger(), 'ArrowDown');
    await press(trigger(), 'Enter');
    expect(onChange).toHaveBeenCalledWith('');
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('Spazio apre e sceglie; Invio apre a menu chiuso', async () => {
    const onChange = vi.fn();
    await mount({ initial: 'IT', onChange });
    trigger().focus();
    await press(trigger(), ' ');
    expect(listbox()).not.toBeNull();
    await press(trigger(), 'ArrowDown');
    await press(trigger(), ' ');
    expect(onChange).toHaveBeenCalledWith('');
    expect(listbox()).toBeNull();
    await press(trigger(), 'Enter');
    expect(listbox()).not.toBeNull();
    expect(activeLabel()).toBe('Tutto il mondo');
  });

  it('le iniziali portano all’opzione (anche a menu chiuso) e Tab chiude senza scegliere', async () => {
    const onChange = vi.fn();
    await mount({ initial: 'IT', onChange });
    trigger().focus();
    await press(trigger(), 's');
    expect(listbox()).not.toBeNull();
    expect(activeLabel()).toBe('Spagna');
    await press(trigger(), 'Tab');
    expect(listbox()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('valore senza opzione: mostra il segnaposto; disattivato: non si apre', async () => {
    await mount({ initial: 'XX', onChange: vi.fn(), disabled: true });
    expect(trigger().textContent).toBe('Scegli un paese');
    expect(trigger().hasAttribute('data-placeholder')).toBe(true);
    expect(trigger().disabled).toBe(true);
    await act(async () => trigger().click());
    expect(listbox()).toBeNull();
  });

  it('su schermo largo anche un menu lungo resta un pannello (niente bottom sheet)', async () => {
    const many = Array.from({ length: 31 }, (_, index) => ({
      value: String(index + 1),
      label: String(index + 1),
    }));
    await mount({ initial: '', options: many, onChange: vi.fn() });
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    await openWithClick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(listbox()).not.toBeNull();
    expect(options()).toHaveLength(31);
  });

  it('col dito (pointer: coarse) il focus entra nell’elenco e alla scelta torna al pulsante', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(pointer: coarse)',
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    const onChange = vi.fn();
    await mount({ initial: 'IT', onChange });
    await openWithClick();
    const list = listbox() as HTMLElement;
    // Pannello (non bottom sheet: lo schermo non è stretto) ma con il focus nell'elenco, così
    // VoiceOver e TalkBack lo raggiungono anche se è in fondo alla pagina.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(list);
    expect(trigger().hasAttribute('aria-activedescendant')).toBe(false);
    const activeId = () => list.getAttribute('aria-activedescendant');
    expect(document.getElementById(activeId() ?? '')?.textContent).toBe('Italia');
    await press(list, 'ArrowDown');
    expect(document.getElementById(activeId() ?? '')?.textContent).toBe('Tutto il mondo');
    await press(list, 'Enter');
    await tick();
    expect(onChange).toHaveBeenCalledWith('');
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());

    // Tab dall'elenco: chiude senza scegliere e il focus torna al pulsante.
    await openWithClick();
    await press(listbox() as HTMLElement, 'Tab');
    await tick();
    expect(listbox()).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger());
  });

  it('griglia: frecce orizzontali di una cella, verticali di una riga; le cifre scelgono il giorno', async () => {
    const onChange = vi.fn();
    const days = Array.from({ length: 31 }, (_, index) => ({
      value: String(index + 1),
      label: String(index + 1),
    }));
    await mount({ initial: '', options: days, columns: 7, onChange });
    trigger().focus();
    await press(trigger(), 'ArrowDown');
    expect(listbox()?.getAttribute('data-layout')).toBe('grid');
    expect(listbox()?.style.getPropertyValue('--columns')).toBe('7');
    expect(activeLabel()).toBe('1');
    await press(trigger(), 'ArrowRight');
    expect(activeLabel()).toBe('2');
    await press(trigger(), 'ArrowDown');
    expect(activeLabel()).toBe('9');
    await press(trigger(), 'ArrowLeft');
    expect(activeLabel()).toBe('8');
    await press(trigger(), 'ArrowUp');
    expect(activeLabel()).toBe('1');
    // «1» poi «5» digitati in fretta: il giorno 15.
    await press(trigger(), '1');
    await press(trigger(), '5');
    expect(activeLabel()).toBe('15');
    await press(trigger(), 'Enter');
    expect(onChange).toHaveBeenCalledWith('15');
  });
});
