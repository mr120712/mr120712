// @polsia:user-owned — sul telefono (viewport stretto, matchMedia simulato) i menu con più di 4
// opzioni si aprono in un bottom sheet: dialog con titolo e pulsante «Chiudi», elenco con il focus e
// aria-activedescendant, scelta col tocco o con la tastiera, chiusura con Esc, sfondo, «Chiudi» o
// trascinando giù l'intestazione (che ha la barretta solo quando il trascinamento è attivo).
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from '@/components/custom/ui-premium/bottom-sheet';
import { SolcoSelect, type SolcoSelectOption } from '@/components/custom/ui-premium/solco-select';

const MONTHS: SolcoSelectOption[] = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
].map((label, index) => ({ value: String(index + 1), label }));

const roots: Array<ReturnType<typeof createRoot>> = [];

function phoneViewport(phone: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: phone && query === '(max-width: 639px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  phoneViewport(true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  vi.unstubAllGlobals();
});

function Harness({
  initial,
  onChange,
  options = MONTHS,
}: {
  initial: string;
  onChange: (value: string) => void;
  options?: SolcoSelectOption[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <SolcoSelect
      id="mese"
      label="Mese"
      placeholder="Mese"
      sheetTitle="Mese del compleanno"
      value={value}
      options={options}
      onValueChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

async function render(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
}

function trigger() {
  const element = document.querySelector<HTMLButtonElement>('[role="combobox"]');
  if (!element) throw new Error('combobox mancante');
  return element;
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function listbox() {
  return document.querySelector<HTMLElement>('[role="listbox"]');
}

function option(label: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === label,
  );
  if (!found) throw new Error(`opzione ${label} mancante`);
  return found;
}

function activeLabel() {
  const id = listbox()?.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent : null;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openSheet() {
  trigger().focus();
  await act(async () => trigger().click());
  await settle();
}

async function press(target: HTMLElement, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

async function pointer(target: Element, type: string, clientY: number) {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 }),
    );
  });
}

describe('SolcoSelect sul telefono: bottom sheet', () => {
  it('più di 4 opzioni: il pulsante annuncia un dialog e apre il bottom sheet', async () => {
    await render(<Harness initial="3" onChange={vi.fn()} />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    await openSheet();
    const sheet = dialog();
    expect(sheet).not.toBeNull();
    const titleId = sheet?.getAttribute('aria-labelledby');
    expect(titleId && document.getElementById(titleId)?.textContent).toBe('Mese del compleanno');
    // Nessuna descrizione: niente aria-describedby verso un id assente.
    expect(sheet?.hasAttribute('aria-describedby')).toBe(false);
    expect(sheet?.querySelector('button[aria-label="Chiudi"]')).not.toBeNull();
    // Barretta in cima: c'è perché il foglio si trascina davvero.
    expect(sheet?.querySelector('[data-draggable] > span[aria-hidden="true"]')).not.toBeNull();
    // Il focus entra nell'elenco, sull'opzione scelta (spunta rosa, aria-selected).
    expect(document.activeElement).toBe(listbox());
    expect(listbox()?.getAttribute('aria-label')).toBe('Mese');
    expect(trigger().getAttribute('aria-controls')).toBe(listbox()?.id);
    expect(activeLabel()).toBe('marzo');
    expect(option('marzo').getAttribute('aria-selected')).toBe('true');
    expect(option('marzo').querySelectorAll('svg')).toHaveLength(1);
    expect(option('aprile').getAttribute('aria-selected')).toBe('false');
  });

  it('un tocco su un’opzione la sceglie, chiude il foglio e riporta il focus al pulsante', async () => {
    const onChange = vi.fn();
    await render(<Harness initial="3" onChange={onChange} />);
    await openSheet();
    await act(async () => option('maggio').click());
    await settle();
    expect(onChange).toHaveBeenCalledWith('5');
    expect(dialog()).toBeNull();
    expect(trigger().textContent).toBe('maggio');
    expect(document.activeElement).toBe(trigger());
  });

  it('«Chiudi» chiude senza cambiare la scelta', async () => {
    const onChange = vi.fn();
    await render(<Harness initial="3" onChange={onChange} />);
    await openSheet();
    await act(async () =>
      dialog()?.querySelector<HTMLButtonElement>('button[aria-label="Chiudi"]')?.click(),
    );
    await settle();
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it('Esc chiude senza cambiare la scelta', async () => {
    const onChange = vi.fn();
    await render(<Harness initial="3" onChange={onChange} />);
    await openSheet();
    await press(listbox() as HTMLElement, 'Escape');
    await settle();
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('un tocco sullo sfondo chiude il foglio', async () => {
    const onChange = vi.fn();
    await render(<Harness initial="3" onChange={onChange} />);
    await openSheet();
    const backdrop = dialog()?.previousElementSibling;
    expect(backdrop?.getAttribute('data-state')).toBe('open');
    await act(async () => {
      backdrop?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('tastiera nel foglio: frecce, Home/Fine e Invio sull’elenco', async () => {
    const onChange = vi.fn();
    await render(<Harness initial="3" onChange={onChange} />);
    await openSheet();
    const list = listbox() as HTMLElement;
    await press(list, 'ArrowDown');
    expect(activeLabel()).toBe('aprile');
    await press(list, 'End');
    expect(activeLabel()).toBe('giugno');
    await press(list, 'Home');
    expect(activeLabel()).toBe('gennaio');
    await press(list, 'Enter');
    await settle();
    expect(onChange).toHaveBeenCalledWith('1');
    expect(dialog()).toBeNull();
  });

  it('trascinare giù l’intestazione chiude; un trascinamento breve rimette il foglio a posto', async () => {
    const onChange = vi.fn();
    await render(<Harness initial="3" onChange={onChange} />);
    await openSheet();
    const header = dialog()?.querySelector('[data-draggable]') as HTMLElement;
    const title = header.querySelector('h2') as HTMLElement;

    // Breve: torna su.
    await pointer(title, 'pointerdown', 100);
    expect(dialog()?.hasAttribute('data-dragging')).toBe(true);
    await pointer(header, 'pointermove', 120);
    expect(dialog()?.style.getPropertyValue('--sheet-drag')).toBe('20px');
    await pointer(header, 'pointerup', 120);
    expect(dialog()).not.toBeNull();
    expect(dialog()?.hasAttribute('data-dragging')).toBe(false);
    expect(dialog()?.style.getPropertyValue('--sheet-drag')).toBe('0px');

    // Lungo: si chiude, senza cambiare la scelta.
    await pointer(title, 'pointerdown', 100);
    await pointer(header, 'pointermove', 260);
    await pointer(header, 'pointermove', 420);
    await pointer(header, 'pointerup', 420);
    await settle();
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('il pulsante «Chiudi» non avvia il trascinamento', async () => {
    await render(<Harness initial="3" onChange={vi.fn()} />);
    await openSheet();
    const close = dialog()?.querySelector('button[aria-label="Chiudi"]') as HTMLElement;
    await pointer(close, 'pointerdown', 100);
    expect(dialog()?.hasAttribute('data-dragging')).toBe(false);
  });

  it('con 4 opzioni o meno anche sul telefono si usa il pannello a tendina', async () => {
    await render(<Harness initial="1" options={MONTHS.slice(0, 4)} onChange={vi.fn()} />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    await openSheet();
    expect(dialog()).toBeNull();
    expect(listbox()).not.toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('su schermo largo lo stesso menu è un pannello', async () => {
    phoneViewport(false);
    await render(<Harness initial="3" onChange={vi.fn()} />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    await openSheet();
    expect(dialog()).toBeNull();
    expect(listbox()).not.toBeNull();
  });
});

describe('BottomSheet', () => {
  it('con descrizione: aria-describedby; senza trascinamento: niente barretta e niente drag', async () => {
    const onOpenChange = vi.fn();
    await render(
      <BottomSheet
        open
        onOpenChange={onOpenChange}
        title="Ordina"
        description="Scegli come ordinare i brani."
        draggable={false}
      >
        <p>Contenuto</p>
      </BottomSheet>,
    );
    const sheet = dialog() as HTMLElement;
    const descriptionId = sheet.getAttribute('aria-describedby');
    expect(descriptionId && document.getElementById(descriptionId)?.textContent).toBe(
      'Scegli come ordinare i brani.',
    );
    expect(sheet.querySelector('[data-draggable]')).toBeNull();
    expect(sheet.querySelector('span[aria-hidden="true"]:empty')).toBeNull();
    const title = sheet.querySelector('h2') as HTMLElement;
    await pointer(title, 'pointerdown', 100);
    await pointer(title, 'pointermove', 500);
    await pointer(title, 'pointerup', 500);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(sheet.textContent).toContain('Contenuto');
  });
});
