// @polsia:user-owned — controllo segmentato premium (SegmentedControl): radiogroup ARIA con
// aria-checked, «roving tabindex», clic, frecce (anche da destra a sinistra), Home/Fine, Invio e
// Spazio, opzioni e gruppo disattivati, indicatore rosa sotto l'opzione attiva.
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SegmentedControl,
  type SegmentedOption,
} from '@/components/custom/ui-premium/segmented-control';

type Visibility = 'private' | 'public' | 'friends';

const BINARY: SegmentedOption<Visibility>[] = [
  { value: 'private', label: 'Privato', icon: <svg data-icon="lock" /> },
  { value: 'public', label: 'Pubblico', icon: <svg data-icon="globe" /> },
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
  options = BINARY,
  disabled = false,
}: {
  initial: Visibility | null;
  onChange: (value: Visibility) => void;
  options?: SegmentedOption<Visibility>[];
  disabled?: boolean;
}) {
  const [value, setValue] = useState<Visibility | null>(initial);
  return (
    <>
      <span id="label">Visibilità del profilo</span>
      <span id="hint">I profili privati non compaiono nella community.</span>
      <SegmentedControl
        aria-labelledby="label"
        aria-describedby="hint"
        value={value}
        options={options}
        disabled={disabled}
        onValueChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    </>
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

function radios(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

function checkedLabels(container: HTMLElement) {
  return radios(container)
    .filter((radio) => radio.getAttribute('aria-checked') === 'true')
    .map((radio) => radio.textContent);
}

async function press(target: HTMLElement, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('SegmentedControl', () => {
  it('è un radiogroup con nome e descrizione; ogni opzione è un radio con aria-checked', async () => {
    const container = await mount({ initial: 'private', onChange: vi.fn() });
    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('aria-labelledby')).toBe('label');
    expect(group?.getAttribute('aria-describedby')).toBe('hint');
    expect(group?.hasAttribute('data-has-value')).toBe(true);
    const [privateRadio, publicRadio] = radios(container);
    expect(radios(container)).toHaveLength(2);
    expect(privateRadio?.getAttribute('aria-checked')).toBe('true');
    expect(publicRadio?.getAttribute('aria-checked')).toBe('false');
    expect(privateRadio?.textContent).toBe('Privato');
    expect(privateRadio?.type).toBe('button');
    // Le icone sono decorative: il nome accessibile resta l'etichetta.
    expect(privateRadio?.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    // Roving tabindex: il Tab entra solo sull'opzione scelta.
    expect(privateRadio?.tabIndex).toBe(0);
    expect(publicRadio?.tabIndex).toBe(-1);
    // L'indicatore rosa (decorativo) sa dove stare.
    expect(group?.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    expect((group as HTMLElement).style.getPropertyValue('--active-index')).toBe('0');
    expect((group as HTMLElement).style.getPropertyValue('--segments')).toBe('2');
  });

  it('un clic cambia la scelta; ricliccare quella attiva non notifica nulla', async () => {
    const onChange = vi.fn();
    const container = await mount({ initial: 'private', onChange });
    await act(async () => radios(container)[1]?.click());
    expect(onChange).toHaveBeenCalledWith('public');
    expect(checkedLabels(container)).toEqual(['Pubblico']);
    expect(radios(container)[1]?.tabIndex).toBe(0);
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]');
    expect(group?.style.getPropertyValue('--active-index')).toBe('1');

    await act(async () => radios(container)[1]?.click());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('frecce: scelgono e spostano il focus, ricominciando dall’altro capo', async () => {
    const onChange = vi.fn();
    const container = await mount({ initial: 'private', onChange });
    const [privateRadio, publicRadio] = radios(container);
    privateRadio?.focus();

    await press(privateRadio as HTMLElement, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('public');
    expect(document.activeElement).toBe(publicRadio);
    expect(checkedLabels(container)).toEqual(['Pubblico']);

    await press(publicRadio as HTMLElement, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('private');
    expect(document.activeElement).toBe(privateRadio);

    await press(privateRadio as HTMLElement, 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('public');

    await press(publicRadio as HTMLElement, 'ArrowUp');
    expect(onChange).toHaveBeenLastCalledWith('private');

    await press(privateRadio as HTMLElement, 'ArrowDown');
    expect(onChange).toHaveBeenLastCalledWith('public');
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it('Home e Fine scelgono la prima e l’ultima opzione', async () => {
    const onChange = vi.fn();
    const options: SegmentedOption<Visibility>[] = [
      ...BINARY,
      { value: 'friends', label: 'Amici' },
    ];
    const container = await mount({ initial: 'public', onChange, options });
    const middle = radios(container)[1] as HTMLElement;
    middle.focus();
    await press(middle, 'End');
    expect(onChange).toHaveBeenLastCalledWith('friends');
    expect(document.activeElement).toBe(radios(container)[2]);
    await press(radios(container)[2] as HTMLElement, 'Home');
    expect(onChange).toHaveBeenLastCalledWith('private');
    expect(document.activeElement).toBe(radios(container)[0]);
  });

  it('Invio e Spazio scelgono l’opzione a fuoco (senza inviare form)', async () => {
    const onChange = vi.fn();
    const container = await mount({ initial: 'private', onChange });
    const publicRadio = radios(container)[1] as HTMLElement;
    publicRadio.focus();
    await press(publicRadio, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith('public');
    const privateRadio = radios(container)[0] as HTMLElement;
    privateRadio.focus();
    await press(privateRadio, ' ');
    expect(onChange).toHaveBeenLastCalledWith('private');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('le opzioni disattivate si saltano con le frecce e non si scelgono col clic', async () => {
    const onChange = vi.fn();
    const options: SegmentedOption<Visibility>[] = [
      { value: 'private', label: 'Privato' },
      { value: 'friends', label: 'Amici', disabled: true },
      { value: 'public', label: 'Pubblico' },
    ];
    const container = await mount({ initial: 'private', onChange, options });
    const [first, middle, last] = radios(container);
    expect(middle?.disabled).toBe(true);
    await act(async () => middle?.click());
    expect(onChange).not.toHaveBeenCalled();
    first?.focus();
    await press(first as HTMLElement, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('public');
    expect(document.activeElement).toBe(last);
  });

  it('gruppo disattivato: nessuna scelta possibile, aria-disabled sul gruppo', async () => {
    const onChange = vi.fn();
    const container = await mount({ initial: 'private', onChange, disabled: true });
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    for (const radio of radios(container)) expect(radio.disabled).toBe(true);
    await act(async () => radios(container)[1]?.click());
    await press(radios(container)[0] as HTMLElement, 'ArrowRight');
    expect(onChange).not.toHaveBeenCalled();
    expect(checkedLabels(container)).toEqual(['Privato']);
  });

  it('senza valore: nessun radio scelto, il Tab entra sul primo, indicatore nascosto', async () => {
    const container = await mount({ initial: null, onChange: vi.fn() });
    expect(checkedLabels(container)).toEqual([]);
    expect(radios(container)[0]?.tabIndex).toBe(0);
    expect(radios(container)[1]?.tabIndex).toBe(-1);
    expect(container.querySelector('[role="radiogroup"]')?.hasAttribute('data-has-value')).toBe(
      false,
    );
  });
});
