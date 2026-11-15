// @polsia:user-owned — bottom sheet di Solco per il telefono: sale dal basso con angoli superiori
// arrotondati, sfondo viola/nero, sopra la tab bar e il mini player (z-index più alto) e rispetta la
// safe area di iPhone. È un dialog modale Radix (focus intrappolato, resto della pagina inerte per i
// lettori di schermo, scroll della pagina bloccato) e si chiude con Esc, toccando lo sfondo, con il
// pulsante «Chiudi» oppure trascinando verso il basso l'intestazione con la barretta (la barretta si
// vede solo quando il trascinamento è davvero attivo).
'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { useRef } from 'react';
import { cn } from '@/lib/utils';
import styles from './bottom-sheet.module.css';

export type BottomSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Titolo visibile del foglio: è anche il nome accessibile del dialog. */
  title: string;
  description?: string;
  children: ReactNode;
  /** Trascinamento verso il basso per chiudere (predefinito: attivo, con la barretta in cima). */
  draggable?: boolean;
  className?: string;
  /** Dove mettere il focus all'apertura (predefinito Radix: il primo elemento attivabile). */
  onOpenAutoFocus?: (event: Event) => void;
  /** Dove riportare il focus alla chiusura (predefinito Radix: l'elemento attivo prima). */
  onCloseAutoFocus?: (event: Event) => void;
};

/** Oltre questa distanza (px) il rilascio chiude il foglio; sotto, torna su. */
const DISMISS_DISTANCE = 120;
/** Un colpo veloce verso il basso (px/ms) chiude anche se breve. */
const DISMISS_VELOCITY = 0.5;

type DragState = { pointerId: number; startY: number; startTime: number; offset: number };

export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  draggable = true,
  className,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);

  /** Sposta il foglio di `offset` px (e attenua lo sfondo) seguendo il dito. */
  const follow = (offset: number) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.style.setProperty('--sheet-drag', `${offset}px`);
    const overlay = overlayRef.current;
    if (overlay) {
      const progress = Math.min(Math.max(offset, 0) / Math.max(sheet.offsetHeight, 1), 1);
      overlay.style.opacity = String(1 - progress * 0.85);
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const sheet = sheetRef.current;
    if (!sheet) return;
    delete sheet.dataset.dragging;
    const elapsed = Math.max(performance.now() - state.startTime, 1);
    const height = sheet.offsetHeight || Number.POSITIVE_INFINITY;
    const far = state.offset > Math.min(DISMISS_DISTANCE, height * 0.35);
    const fast = state.offset > 24 && state.offset / elapsed > DISMISS_VELOCITY;
    if (!cancelled && (far || fast)) {
      // L'animazione d'uscita parte dalla posizione attuale (--sheet-drag), senza scatti.
      onOpenChange(false);
      return;
    }
    // Rilascio corto: il foglio torna su con la sua transizione.
    follow(0);
    if (overlayRef.current) overlayRef.current.style.opacity = '';
  };

  const dragHandlers = draggable
    ? {
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
          if (event.button !== 0) return;
          // Il pulsante «Chiudi» resta un pulsante: non avvia il trascinamento.
          if ((event.target as Element).closest('button')) return;
          drag.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startTime: performance.now(),
            offset: 0,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          if (sheetRef.current) sheetRef.current.dataset.dragging = 'true';
        },
        onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
          const state = drag.current;
          if (!state || state.pointerId !== event.pointerId) return;
          const delta = event.clientY - state.startY;
          // Verso l'alto solo un accenno elastico; verso il basso segue il dito.
          state.offset = delta < 0 ? Math.max(delta / 4, -16) : delta;
          follow(state.offset);
        },
        onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => endDrag(event, false),
        onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => endDrag(event, true),
      }
    : {};

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay ref={overlayRef} className={styles.backdrop} />
        <Dialog.Content
          ref={sheetRef}
          className={cn(styles.sheet, className)}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          // Senza descrizione niente aria-describedby (Radix altrimenti punta a un id assente).
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className={styles.header} data-draggable={draggable || undefined} {...dragHandlers}>
            {draggable ? <span className={styles.grabber} aria-hidden="true" /> : null}
            <div className={styles.titleRow}>
              <div className={styles.titles}>
                <Dialog.Title className={styles.title}>{title}</Dialog.Title>
                {description ? (
                  <Dialog.Description className={styles.description}>
                    {description}
                  </Dialog.Description>
                ) : null}
              </div>
              <Dialog.Close className={styles.close} aria-label="Chiudi">
                <X aria-hidden="true" />
              </Dialog.Close>
            </div>
          </div>
          <div className={styles.body}>{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
