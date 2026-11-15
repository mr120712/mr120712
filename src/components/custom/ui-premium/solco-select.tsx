// @polsia:user-owned — menu a tendina premium di Solco, al posto dei <select> nativi: pulsante viola
// scurissimo con chevron che ruota, pannello in un portale (mai tagliato dai contenitori, mai sotto
// tab bar e mini player) con bordo viola, icone facoltative e spunta rosa sull'opzione scelta. Sul
// telefono, con più di 4 opzioni, le stesse opzioni si aprono in un bottom sheet.
// Accessibilità: pattern ARIA «combobox select-only». Nel pannello aperto con mouse o tastiera il
// focus resta sul pulsante e l'opzione attiva è indicata da aria-activedescendant; aperto col dito
// e nel bottom sheet il focus passa all'elenco (VoiceOver e TalkBack non seguono activedescendant)
// e alla chiusura torna al pulsante. Tastiera: frecce, Home/Fine, PagSu/PagGiù, Invio/Spazio per
// scegliere, Esc e Tab per chiudere, lettere o cifre per saltare all'opzione che inizia così.
// prefers-reduced-motion: nessuna animazione; contrasto elevato: colori di sistema.
'use client';

import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { BottomSheet } from '@/components/custom/ui-premium/bottom-sheet';
import { usePhoneViewport } from '@/hooks/use-phone-viewport';
import { cn } from '@/lib/utils';
import styles from './solco-select.module.css';

export type SolcoSelectOption<V extends string = string> = {
  value: V;
  label: string;
  /** Icona minimale accanto all'etichetta (decorativa). */
  icon?: ReactNode;
  /** Riga secondaria più tenue (facoltativa). */
  description?: string;
  disabled?: boolean;
};

export type SolcoSelectProps<V extends string = string> = {
  value: V;
  /** Chiamata solo quando la scelta cambia davvero (come l'evento change del <select>). */
  onValueChange: (value: V) => void;
  options: readonly SolcoSelectOption<V>[];
  /** Testo del pulsante quando nessuna opzione corrisponde al valore. */
  placeholder?: string;
  /** Nome accessibile del menu (pulsante ed elenco) e titolo predefinito del bottom sheet. */
  label?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  id?: string;
  /** Icona del pulsante quando l'opzione scelta non ne ha una propria. */
  icon?: ReactNode;
  /** Titolo del bottom sheet (predefinito: `label`, poi `placeholder`). */
  sheetTitle?: string;
  disabled?: boolean;
  size?: 'md' | 'sm';
  shape?: 'rounded' | 'pill';
  className?: string;
  /** Sul telefono si usa il bottom sheet quando le opzioni sono più di così (predefinito 4). */
  sheetThreshold?: number;
  /**
   * Opzioni brevi in griglia (es. 7 colonne per i giorni del mese): tutte visibili insieme, celle
   * grandi da toccare. Frecce destra/sinistra: opzione accanto; su/giù: riga sopra/sotto.
   */
  columns?: number;
};

type StyleWithVars = CSSProperties & Record<`--${string}`, string | number>;

/** Spazio dal bordo della finestra che il pannello non occupa mai. */
const VIEWPORT_MARGIN = 8;
/** Salto di PagSu/PagGiù. */
const PAGE_STEP = 8;
/** Pausa (ms) oltre la quale la ricerca per iniziali ricomincia da capo. */
const TYPEAHEAD_RESET_MS = 700;

type Mode = 'panel' | 'sheet';

/**
 * Altezza occupata in basso da tab bar (solo mobile) e mini player (quando c'è): la legge dalle
 * variabili CSS --tab-bar-offset e --mini-player-height con una sonda invisibile nel body, così il
 * pannello si apre sopra il pulsante invece di finire sotto la barra di navigazione.
 */
function measureBottomObstruction(): number {
  if (typeof document === 'undefined') return 0;
  const probe = document.createElement('div');
  probe.className = cn(
    styles.bottomProbe,
    document.body.classList.contains('has-music-player') && styles.withPlayer,
  );
  probe.setAttribute('aria-hidden', 'true');
  document.body.append(probe);
  const { height } = probe.getBoundingClientRect();
  probe.remove();
  return Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
}

/** Porta in vista l'opzione dentro il suo elenco scorrevole, senza mai far scorrere la pagina. */
function revealOption(list: HTMLElement, option: HTMLElement, center: boolean) {
  const listBox = list.getBoundingClientRect();
  const optionBox = option.getBoundingClientRect();
  const top = optionBox.top - listBox.top + list.scrollTop;
  const bottom = top + optionBox.height;
  if (center) {
    list.scrollTop = Math.max(0, top - (list.clientHeight - optionBox.height) / 2);
  } else if (top < list.scrollTop) {
    list.scrollTop = top;
  } else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight;
  }
}

/**
 * Dito invece di mouse: aperto il pannello, il focus entra nell'elenco. I lettori di schermo dei
 * telefoni (VoiceOver, TalkBack) non seguono aria-activedescendant e troverebbero il pannello solo
 * in fondo alla pagina (è in un portale).
 */
function prefersFocusInList() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches === true
  );
}

function isTypeaheadKey(event: KeyboardEvent) {
  return (
    event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

export function SolcoSelect<V extends string = string>({
  value,
  onValueChange,
  options,
  placeholder = 'Scegli…',
  label,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  id,
  icon,
  sheetTitle,
  disabled = false,
  size = 'md',
  shape = 'rounded',
  className,
  sheetThreshold = 4,
  columns,
}: SolcoSelectProps<V>) {
  const grid = columns !== undefined && columns > 1 ? Math.floor(columns) : 0;
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const isPhone = usePhoneViewport();
  const wantsSheet = isPhone && options.length > sheetThreshold;

  const [open, setOpen] = useState(false);
  // La modalità si decide all'apertura e resta fissa finché il menu è aperto (es. rotazione).
  const [mode, setMode] = useState<Mode>('panel');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [bottomObstruction, setBottomObstruction] = useState(0);
  // Dove sta il focus a menu aperto: sull'elenco (bottom sheet, o pannello aperto col dito) oppure
  // sul pulsante (pannello con mouse e tastiera, pattern combobox con aria-activedescendant).
  const [listFocus, setListFocus] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
  // Invio/Spazio già gestiti in keydown: il clic sintetico che alcuni browser aggiungono va ignorato.
  const keyboardClick = useRef(false);
  // All'apertura l'opzione scelta va al centro dell'elenco; con la tastiera si scorre solo il
  // necessario; il passaggio del mouse non fa mai scorrere l'elenco.
  const reveal = useRef<'center' | 'nearest' | null>(null);
  // Chiuso da un tocco altrove: il focus resta dove l'utente è andato, non torna al pulsante.
  const interactedOutside = useRef(false);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const firstEnabled = options.findIndex((option) => !option.disabled);
  let lastEnabled = -1;
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) {
      lastEnabled = index;
      break;
    }
  }

  /** Opzione attivabile più vicina a `target` nella direzione `step` (senza ricominciare). */
  const enabledFrom = (target: number, step: 1 | -1) => {
    for (let index = target; index >= 0 && index < options.length; index += step) {
      if (!options[index]?.disabled) return index;
    }
    return -1;
  };

  const openMenu = (start: 'selected' | 'first' | 'last' = 'selected') => {
    if (disabled || options.length === 0) return;
    const selectedUsable = selectedIndex >= 0 && !options[selectedIndex]?.disabled;
    const initial =
      start === 'first'
        ? firstEnabled
        : start === 'last'
          ? lastEnabled
          : selectedUsable
            ? selectedIndex
            : firstEnabled;
    const nextMode: Mode = wantsSheet ? 'sheet' : 'panel';
    if (nextMode === 'panel') setBottomObstruction(measureBottomObstruction());
    reveal.current = 'center';
    interactedOutside.current = false;
    setListFocus(nextMode === 'sheet' || prefersFocusInList());
    setMode(nextMode);
    setActiveIndex(initial);
    setOpen(true);
  };

  const closeMenu = () => setOpen(false);

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    if (option.value !== value) onValueChange(option.value);
  };

  /** Prima opzione attivabile, a partire da `start` (e ricominciando), che inizia con `needle`. */
  const findPrefix = (needle: string, start: number) => {
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (((start + offset) % options.length) + options.length) % options.length;
      const option = options[index];
      if (
        option &&
        !option.disabled &&
        option.label.toLocaleLowerCase('it-IT').startsWith(needle)
      ) {
        return index;
      }
    }
    return -1;
  };

  /**
   * Ricerca per iniziali: le lettere digitate in fretta formano un prefisso («ma» → marzo, «15» →
   * 15); la stessa lettera ripetuta, se nessuna opzione inizia così, scorre tra quelle che iniziano
   * con quella lettera (come i <select> nativi).
   */
  const findByTypeahead = (key: string, from: number) => {
    const now = Date.now();
    const state = typeahead.current;
    state.text = now - state.at > TYPEAHEAD_RESET_MS ? key : state.text + key;
    state.at = now;
    const query = state.text.toLocaleLowerCase('it-IT');
    if (query.length === 1) return findPrefix(query, from + 1);
    const match = findPrefix(query, Math.max(from, 0));
    if (match >= 0) return match;
    const first = query[0] ?? '';
    return [...query].every((char) => char === first) ? findPrefix(first, from + 1) : -1;
  };

  /** Tasti dell'elenco aperto (pannello: sul pulsante; bottom sheet: sull'elenco). */
  const navigate = (event: KeyboardEvent<HTMLElement>): boolean => {
    let next = -1;
    // In griglia su/giù saltano di una riga; in elenco di un'opzione.
    const row = grid || 1;
    switch (event.key) {
      case 'ArrowDown':
        next = activeIndex < 0 ? firstEnabled : enabledFrom(activeIndex + row, 1);
        break;
      case 'ArrowUp':
        if (event.altKey) {
          commit(activeIndex);
          return true;
        }
        next = activeIndex < 0 ? lastEnabled : enabledFrom(activeIndex - row, -1);
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        // Solo in griglia (in un elenco verticale le frecce orizzontali non fanno nulla).
        if (!grid) return false;
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
        const step = (event.key === 'ArrowRight') !== rtl ? 1 : -1;
        next = activeIndex < 0 ? firstEnabled : enabledFrom(activeIndex + step, step);
        break;
      }
      case 'Home':
        next = firstEnabled;
        break;
      case 'End':
        next = lastEnabled;
        break;
      case 'PageDown': {
        const target = enabledFrom(Math.min(activeIndex + PAGE_STEP, options.length - 1), -1);
        next = target > activeIndex ? target : lastEnabled;
        break;
      }
      case 'PageUp': {
        const target = enabledFrom(Math.max(activeIndex - PAGE_STEP, 0), 1);
        next = target >= 0 && target < activeIndex ? target : firstEnabled;
        break;
      }
      case 'Enter':
      case ' ':
        commit(activeIndex);
        return true;
      default:
        if (isTypeaheadKey(event)) {
          next = findByTypeahead(event.key, activeIndex);
          break;
        }
        return false;
    }
    if (next >= 0) {
      reveal.current = 'nearest';
      setActiveIndex(next);
    }
    return true;
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openMenu(event.key === 'ArrowUp' && selectedIndex < 0 ? 'last' : 'selected');
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        openMenu(event.key === 'Home' ? 'first' : 'last');
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        keyboardClick.current = true;
        openMenu();
      } else if (isTypeaheadKey(event)) {
        // Come un <select> chiuso: la lettera apre il menu sull'opzione che inizia così.
        event.preventDefault();
        const match = findByTypeahead(event.key, selectedIndex);
        openMenu();
        if (match >= 0) setActiveIndex(match);
      }
      return;
    }
    if (mode !== 'panel') return;
    if (event.key === 'Tab') {
      // Il Tab prosegue normalmente: il menu si chiude senza cambiare la scelta.
      closeMenu();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') keyboardClick.current = true;
    if (navigate(event)) event.preventDefault();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (navigate(event)) event.preventDefault();
  };

  /** Pannello con il focus nell'elenco (aperto col dito): come sopra, e Tab chiude. */
  const onPanelListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      // Il focus torna al pulsante (onCloseAutoFocus): da lì il Tab prosegue nella pagina.
      event.preventDefault();
      closeMenu();
      return;
    }
    onListKeyDown(event);
  };

  // L'opzione attiva resta visibile nell'elenco: centrata all'apertura, poi seguita dalla tastiera.
  useEffect(() => {
    if (!open || activeIndex < 0 || !reveal.current) return;
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const option = document.getElementById(`${baseId}-option-${activeIndex}`);
      if (!list || !option || !reveal.current) return;
      revealOption(list, option, reveal.current === 'center');
      reveal.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, activeIndex, baseId]);

  const panelOpen = open && mode === 'panel';
  const sheetOpen = open && mode === 'sheet';
  const triggerIcon = selected?.icon ?? icon;
  const listName = ariaLabelledBy ? undefined : (label ?? placeholder);
  const layout = grid ? 'grid' : undefined;
  const layoutStyle: StyleWithVars | undefined = grid ? { '--columns': grid } : undefined;

  const renderOptions = () =>
    options.length === 0 ? (
      <p className={styles.empty}>Nessuna opzione disponibile.</p>
    ) : (
      options.map((option, index) => {
        const isSelected = index === selectedIndex;
        return (
          // biome-ignore lint/a11y/useFocusableInteractive: pattern ARIA listbox con aria-activedescendant: il focus resta sul pulsante (o sull'elenco), le opzioni non entrano nel giro del Tab.
          // biome-ignore lint/a11y/useKeyWithClickEvents: la tastiera è gestita da chi ha il focus (pulsante o elenco); il clic serve a mouse e tocco.
          <div
            key={option.value}
            id={optionId(index)}
            role="option"
            aria-selected={isSelected}
            aria-disabled={option.disabled || undefined}
            data-active={index === activeIndex || undefined}
            className={styles.option}
            // Il focus resta dov'è (pulsante o elenco): il clic sceglie e basta.
            onMouseDown={(event) => event.preventDefault()}
            onPointerMove={() => {
              if (!option.disabled && index !== activeIndex) setActiveIndex(index);
            }}
            onClick={() => commit(index)}
          >
            {option.icon ? (
              <span className={styles.optionIcon} aria-hidden="true">
                {option.icon}
              </span>
            ) : null}
            <span className={styles.optionText}>
              <span className={styles.optionLabel}>{option.label}</span>
              {option.description ? (
                <span className={styles.optionDescription}>{option.description}</span>
              ) : null}
            </span>
            <span className={styles.checkSlot} aria-hidden="true">
              {isSelected ? <Check className={styles.check} /> : null}
            </span>
          </div>
        );
      })
    );

  return (
    <>
      <Popover.Root
        open={panelOpen}
        onOpenChange={(next) => {
          if (!next) closeMenu();
        }}
      >
        <Popover.Anchor asChild>
          <button
            ref={triggerRef}
            id={id}
            type="button"
            role="combobox"
            aria-haspopup={wantsSheet ? 'dialog' : 'listbox'}
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-activedescendant={
              panelOpen && !listFocus && activeIndex >= 0 ? optionId(activeIndex) : undefined
            }
            aria-label={ariaLabelledBy ? undefined : label}
            aria-labelledby={ariaLabelledBy}
            aria-describedby={ariaDescribedBy}
            disabled={disabled}
            data-state={open ? 'open' : 'closed'}
            data-placeholder={selected ? undefined : ''}
            className={cn(
              styles.trigger,
              size === 'sm' && styles.sm,
              shape === 'pill' && styles.pill,
              className,
            )}
            onClick={() => {
              if (keyboardClick.current) {
                keyboardClick.current = false;
                return;
              }
              if (open) closeMenu();
              else openMenu();
            }}
            onKeyDown={onTriggerKeyDown}
            onKeyUp={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              // Il clic sintetico (se arriva) segue subito il keyup: poi si torna al normale.
              window.setTimeout(() => {
                keyboardClick.current = false;
              }, 0);
            }}
          >
            {triggerIcon ? (
              <span className={styles.triggerIcon} aria-hidden="true">
                {triggerIcon}
              </span>
            ) : null}
            <span className={styles.value}>{selected ? selected.label : placeholder}</span>
            <ChevronDown aria-hidden="true" className={styles.chevron} />
          </button>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={listName}
            aria-labelledby={ariaLabelledBy}
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={{
              top: VIEWPORT_MARGIN,
              right: VIEWPORT_MARGIN,
              left: VIEWPORT_MARGIN,
              bottom: bottomObstruction + VIEWPORT_MARGIN,
            }}
            className={cn(styles.panel, size === 'sm' && styles.panelSm)}
            data-layout={layout}
            style={layoutStyle}
            aria-activedescendant={
              listFocus && activeIndex >= 0 ? optionId(activeIndex) : undefined
            }
            onOpenAutoFocus={(event) => {
              // Mouse e tastiera: il focus resta sul pulsante (aria-activedescendant).
              // Dito: entra nell'elenco, così lo raggiungono anche VoiceOver e TalkBack.
              event.preventDefault();
              if (listFocus) listRef.current?.focus({ preventScroll: true });
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (listFocus && !interactedOutside.current) {
                triggerRef.current?.focus({ preventScroll: true });
              }
            }}
            onInteractOutside={(event) => {
              // Il pulsante apre e chiude da sé: toccarlo non conta come "fuori".
              if (triggerRef.current?.contains(event.target as Node)) event.preventDefault();
              else interactedOutside.current = true;
            }}
            onFocus={(event) => {
              // Un clic sul bordo del pannello non deve rubare il focus al pulsante.
              if (!listFocus && event.target === event.currentTarget) triggerRef.current?.focus();
            }}
            onKeyDown={listFocus ? onPanelListKeyDown : undefined}
          >
            {renderOptions()}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {wantsSheet || sheetOpen ? (
        <BottomSheet
          open={sheetOpen}
          onOpenChange={(next) => {
            if (!next) closeMenu();
          }}
          title={sheetTitle ?? label ?? placeholder}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            listRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            tabIndex={0}
            aria-label={listName}
            aria-labelledby={ariaLabelledBy}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            className={styles.sheetList}
            data-layout={layout}
            style={layoutStyle}
            onKeyDown={onListKeyDown}
          >
            {renderOptions()}
          </div>
        </BottomSheet>
      ) : null}
    </>
  );
}
