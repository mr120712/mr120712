// @polsia:user-owned — controllo segmentato premium di Solco per le scelte brevi (Fan/Artista,
// Privato/Pubblico, Solo io/Tutti): si cambia con un tocco, senza aprire menu. È un radiogroup ARIA
// con «roving tabindex»: il Tab entra sull'opzione scelta; frecce, Home/Fine scelgono e spostano il
// focus (come i radio nativi); Invio e Spazio scelgono l'opzione a fuoco. L'indicatore rosa scorre
// sotto l'opzione attiva in ~200 ms (nessuna animazione con prefers-reduced-motion).
'use client';

import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';
import { cn } from '@/lib/utils';
import styles from './segmented-control.module.css';

export type SegmentedOption<V extends string> = {
  value: V;
  label: string;
  /** Icona minimale accanto all'etichetta (decorativa: l'etichetta resta il nome accessibile). */
  icon?: ReactNode;
  disabled?: boolean;
};

export type SegmentedControlProps<V extends string> = {
  value: V | null;
  onValueChange: (value: V) => void;
  options: readonly SegmentedOption<V>[];
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  /** Disattiva l'intero gruppo. */
  disabled?: boolean;
  size?: 'md' | 'sm';
  className?: string;
  id?: string;
};

type StyleWithVars = CSSProperties & Record<`--${string}`, string | number>;

function firstEnabledIndex<V extends string>(options: readonly SegmentedOption<V>[]) {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabledIndex<V extends string>(options: readonly SegmentedOption<V>[]) {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function SegmentedControl<V extends string>({
  value,
  onValueChange,
  options,
  disabled = false,
  size = 'md',
  className,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: SegmentedControlProps<V>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const firstEnabled = firstEnabledIndex(options);
  // Il giro del Tab entra sull'opzione scelta, o sulla prima attivabile se nessuna è scelta.
  const tabStop =
    selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : firstEnabled;

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled || disabled) return;
    // Come un radio nativo: riscegliere l'opzione già attiva non notifica nulla.
    if (option.value !== value) onValueChange(option.value);
  };

  /** Prossima opzione attivabile nella direzione `step`, ricominciando dall'altro capo. */
  const neighbour = (from: number, step: 1 | -1) => {
    const count = options.length;
    for (let offset = 1; offset <= count; offset += 1) {
      const index = (((from + step * offset) % count) + count) % count;
      if (!options[index]?.disabled) return index;
    }
    return from;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // In una pagina da destra a sinistra le frecce orizzontali si invertono.
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = neighbour(index, rtl ? -1 : 1);
        break;
      case 'ArrowLeft':
        next = neighbour(index, rtl ? 1 : -1);
        break;
      case 'ArrowDown':
        next = neighbour(index, 1);
        break;
      case 'ArrowUp':
        next = neighbour(index, -1);
        break;
      case 'Home':
        next = firstEnabled;
        break;
      case 'End':
        next = lastEnabledIndex(options);
        break;
      case 'Enter':
      case ' ':
        // Gestiti qui (e non dal clic nativo del pulsante) per un comportamento identico ovunque.
        event.preventDefault();
        choose(index);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (next < 0) return;
    buttons.current[next]?.focus();
    choose(next);
  };

  const style: StyleWithVars = {
    '--segments': Math.max(options.length, 1),
    '--active-index': Math.max(selectedIndex, 0),
  };

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-disabled={disabled || undefined}
      data-has-value={selectedIndex >= 0 || undefined}
      className={cn(styles.root, size === 'sm' && styles.sm, className)}
      style={style}
    >
      {/* Indicatore rosa: scorre sotto l'opzione attiva (solo decorativo). */}
      <span className={styles.indicator} aria-hidden="true" />
      {options.map((option, index) => {
        const checked = index === selectedIndex;
        return (
          // biome-ignore lint/a11y/useSemanticElements: radio ARIA su <button> per il controllo segmentato (indicatore animato, icone); il ruolo e aria-checked danno la stessa semantica di un radio nativo.
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled || option.disabled}
            data-state={checked ? 'checked' : 'unchecked'}
            data-value={option.value}
            className={styles.segment}
            onClick={() => choose(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.icon ? (
              <span className={styles.icon} aria-hidden="true">
                {option.icon}
              </span>
            ) : null}
            <span className={styles.label}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
