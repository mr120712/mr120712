// @polsia:user-owned — chip dei mood in cima alla Home ("Tutto" + 8 mood). La scelta vive nell'URL
// (?mood=relax): router.replace senza ricaricare la pagina, link condivisibili, avanti/indietro del
// browser ripristinano il mood. Pulsanti con aria-pressed in un gruppo con legenda.
'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { findMood, MOOD_QUERY_PARAM, type MoodId, moodCatalog } from '@/lib/music/moods';
import styles from './mood-chips.module.css';

/** Mood scelto nell'URL della pagina (null = "Tutto") e funzione per cambiarlo. */
export function useMoodSelection() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selected = findMood(searchParams.get(MOOD_QUERY_PARAM));
  const queryString = searchParams.toString();

  const select = useCallback(
    (id: MoodId | null) => {
      const next = new URLSearchParams(queryString);
      if (id) next.set(MOOD_QUERY_PARAM, id);
      else next.delete(MOOD_QUERY_PARAM);
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname, queryString],
  );

  return { selected, select };
}

/** Sposta il focus su una chip (es. "Tutto" dopo "Torna a Tutto", che sparisce col feed). */
export function focusMoodChip(id: MoodId | null) {
  document.querySelector<HTMLButtonElement>(`[data-mood-chip="${id ?? 'tutto'}"]`)?.focus();
}

const chips: { id: MoodId | null; label: string }[] = [
  { id: null, label: 'Tutto' },
  ...moodCatalog.map((mood) => ({ id: mood.id, label: mood.label })),
];

/**
 * Spazio lasciato tra la chip e il bordo della riga quando la riga scorre per mostrarla, se il CSS
 * non ne dichiara uno (scroll-padding-inline: 16px al tocco, 44px con le frecce del mouse).
 */
const CHIP_SCROLL_PADDING = 16;

/** The row's scroll-padding-inline: with a mouse it also leaves room for the arrow and the fade. */
function rowScrollPadding(row: HTMLElement) {
  const value = Number.parseFloat(window.getComputedStyle(row).scrollPaddingInlineStart);
  return Number.isFinite(value) && value >= 0 ? value : CHIP_SCROLL_PADDING;
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function scrollRowTo(row: HTMLElement, left: number, behavior: ScrollBehavior) {
  // jsdom and very old engines have no Element.scrollTo: fall back to an instant jump.
  if (typeof row.scrollTo === 'function') row.scrollTo({ left, behavior });
  else row.scrollLeft = left;
}

/**
 * Where the row has to scroll to show the whole chip clear of its edges (the arrows and the fade
 * sit there), moving as little as possible: towards the nearest edge, with `padding`. Null when
 * the chip is already clear, or when the row cannot move further (its ends have no arrow).
 */
export function chipScrollTarget(
  row: { scrollLeft: number; clientWidth: number; scrollWidth: number },
  chip: { offsetLeft: number; offsetWidth: number },
  padding = CHIP_SCROLL_PADDING,
): number | null {
  const start = chip.offsetLeft;
  const end = start + chip.offsetWidth;
  const viewStart = row.scrollLeft;
  const viewEnd = viewStart + row.clientWidth;
  if (start >= viewStart + padding && end <= viewEnd - padding) return null;
  const target = start < viewStart + padding ? start - padding : end + padding - row.clientWidth;
  const max = Math.max(0, row.scrollWidth - row.clientWidth);
  const clamped = Math.min(max, Math.max(0, Math.round(target)));
  return clamped === Math.round(viewStart) ? null : clamped;
}

/** Scrolls the row so the chip is clear of the edges (no-op when it already is). */
function revealChip(row: HTMLElement, chip: HTMLElement, behavior: ScrollBehavior) {
  const target = chipScrollTarget(row, chip, rowScrollPadding(row));
  if (target !== null) scrollRowTo(row, target, behavior);
}

/** Se la riga ha altre chip nascoste a sinistra e a destra (per frecce e sfumature). */
function useRowOverflow(row: RefObject<HTMLDivElement | null>) {
  const [overflow, setOverflow] = useState({ start: false, end: false });

  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const update = () => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setOverflow((current) =>
        current.start === start && current.end === end ? current : { start, end },
      );
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    // The row resizes with the window; the chips grow when the web font arrives.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [row]);

  return overflow;
}

/**
 * La riga di chip. Senza `onSelect` è inerte: è il segnaposto mostrato prima che l'URL sia letto.
 * Con mouse o trackpad, se le chip non entrano, compaiono le frecce per scorrere la riga.
 */
export function MoodChipGroup({
  selectedId,
  onSelect,
}: {
  selectedId: MoodId | null;
  onSelect?: (id: MoodId | null) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);
  const overflow = useRowOverflow(rowRef);

  // A shared link may point at the last chip, and a chosen chip may be cut off at an edge: scroll
  // the row (never the page) just enough to show it. No animation on the first load.
  useEffect(() => {
    const row = rowRef.current;
    const chip = row?.querySelector<HTMLElement>(`[data-mood-chip="${selectedId ?? 'tutto'}"]`);
    const first = firstScroll.current;
    firstScroll.current = false;
    if (!row || !chip) return;
    revealChip(row, chip, first || prefersReducedMotion() ? 'auto' : 'smooth');
  }, [selectedId]);

  // Browsers do not scroll a focused chip they consider visible, even when an arrow covers it:
  // bring the focused chip clear of the edges too.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const onFocusIn = (event: FocusEvent) => {
      const chip = event.target instanceof HTMLElement ? event.target : null;
      if (!chip?.hasAttribute('data-mood-chip')) return;
      revealChip(row, chip, prefersReducedMotion() ? 'auto' : 'smooth');
    };
    row.addEventListener('focusin', onFocusIn);
    return () => row.removeEventListener('focusin', onFocusIn);
  }, []);

  const page = (direction: -1 | 1) => {
    const row = rowRef.current;
    if (!row) return;
    const step = Math.max(row.clientWidth * 0.8, 120);
    const max = Math.max(0, row.scrollWidth - row.clientWidth);
    const left = Math.min(max, Math.max(0, row.scrollLeft + direction * step));
    scrollRowTo(row, left, prefersReducedMotion() ? 'auto' : 'smooth');
  };

  return (
    <fieldset className={styles.group}>
      <legend className="sr-only">Scegli un mood</legend>
      <div className={styles.rail}>
        <div
          ref={rowRef}
          className={styles.chips}
          data-overflow-start={overflow.start || undefined}
          data-overflow-end={overflow.end || undefined}
        >
          {chips.map((chip) => {
            const pressed = chip.id === selectedId;
            return (
              <button
                key={chip.id ?? 'tutto'}
                type="button"
                className={styles.chip}
                aria-pressed={pressed}
                data-mood-chip={chip.id ?? 'tutto'}
                onClick={() => {
                  if (!onSelect) return;
                  // Like a toggle: pressing the selected mood again goes back to "Tutto".
                  if (pressed) {
                    if (chip.id !== null) onSelect(null);
                    return;
                  }
                  onSelect(chip.id);
                }}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
        {/* Pointer-only shortcut (CSS shows it with a fine pointer): keyboard and screen reader
            users reach every chip with Tab, and the row follows the focus. */}
        {overflow.start ? (
          <button
            type="button"
            className={`${styles.scrollButton} ${styles.scrollPrev}`}
            tabIndex={-1}
            aria-hidden="true"
            data-mood-scroll="prev"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => page(-1)}
          >
            <ChevronLeft />
          </button>
        ) : null}
        {overflow.end ? (
          <button
            type="button"
            className={`${styles.scrollButton} ${styles.scrollNext}`}
            tabIndex={-1}
            aria-hidden="true"
            data-mood-scroll="next"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => page(1)}
          >
            <ChevronRight />
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}

/**
 * Link a una sezione del feed "Tutto" (es. "Classifiche" → #tendenze). Con un mood attivo quella
 * sezione è nascosta: il link torna prima a "Tutto" e poi scorre fino alla sezione. Va dentro un
 * <Suspense> (legge useSearchParams).
 */
export function FeedSectionLink({
  targetId,
  className,
  children,
}: {
  targetId: string;
  className?: string;
  children: ReactNode;
}) {
  const { selected, select } = useMoodSelection();
  const [scrollPending, setScrollPending] = useState(false);

  // Runs once "Tutto" is back, when the section is visible again. Like a native in-page link, the
  // next Tab starts from the section (focused without a second scroll), not from this shortcut.
  useEffect(() => {
    if (!scrollPending || selected) return;
    setScrollPending(false);
    const target = document.getElementById(targetId);
    if (!target) return;
    target.scrollIntoView({ block: 'start' });
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }, [scrollPending, selected, targetId]);

  return (
    <Link
      href={`#${targetId}`}
      className={className}
      onClick={(event) => {
        if (!selected) return; // "Tutto": the plain anchor already works.
        event.preventDefault();
        setScrollPending(true);
        select(null);
      }}
    >
      {children}
    </Link>
  );
}

/** Chip collegati all'URL: va dentro un <Suspense> (legge useSearchParams). */
export function MoodChips() {
  const { selected, select } = useMoodSelection();
  return <MoodChipGroup selectedId={selected?.id ?? null} onSelect={select} />;
}
