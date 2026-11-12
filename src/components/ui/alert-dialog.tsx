// @polsia:user-owned — finestra di conferma (WAI-ARIA alertdialog) con la stessa API di shadcn,
// costruita sul Dialog di Radix già installato: role="alertdialog", il focus parte da "Annulla",
// un clic fuori non chiude (si risponde solo con i pulsanti o con Esc).
'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as React from 'react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const CANCEL_ATTRIBUTE = 'data-alert-dialog-cancel';

const AlertDialog = DialogPrimitive.Root;

const AlertDialogTrigger = DialogPrimitive.Trigger;

const AlertDialogPortal = DialogPrimitive.Portal;

const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
AlertDialogOverlay.displayName = 'AlertDialogOverlay';

const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, onOpenAutoFocus, onPointerDownOutside, onInteractOutside, ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      role="alertdialog"
      onOpenAutoFocus={(event) => {
        onOpenAutoFocus?.(event);
        if (event.defaultPrevented) return;
        // Focus starts on the safe choice, as in the WAI-ARIA alert dialog pattern.
        const content = event.currentTarget;
        const cancel =
          content instanceof HTMLElement
            ? content.querySelector<HTMLElement>(`[${CANCEL_ATTRIBUTE}]`)
            : null;
        if (cancel) {
          event.preventDefault();
          cancel.focus();
        }
      }}
      onPointerDownOutside={(event) => {
        onPointerDownOutside?.(event);
        event.preventDefault();
      }}
      onInteractOutside={(event) => {
        onInteractOutside?.(event);
        event.preventDefault();
      }}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  </AlertDialogPortal>
));
AlertDialogContent.displayName = 'AlertDialogContent';

const AlertDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-2 text-center sm:text-left', className)} {...props} />
);
AlertDialogHeader.displayName = 'AlertDialogHeader';

const AlertDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
    {...props}
  />
);
AlertDialogFooter.displayName = 'AlertDialogFooter';

const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-snug [overflow-wrap:anywhere]', className)}
    {...props}
  />
));
AlertDialogTitle.displayName = 'AlertDialogTitle';

const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm leading-relaxed text-muted-foreground', className)}
    {...props}
  />
));
AlertDialogDescription.displayName = 'AlertDialogDescription';

/** Confirms and closes the dialog (call event.preventDefault() in onClick to keep it open). */
const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close ref={ref} className={cn(buttonVariants(), className)} {...props} />
));
AlertDialogAction.displayName = 'AlertDialogAction';

/** Closes without doing anything; it receives the focus when the dialog opens. */
const AlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close
    ref={ref}
    {...{ [CANCEL_ATTRIBUTE]: '' }}
    className={cn(buttonVariants({ variant: 'outline' }), className)}
    {...props}
  />
));
AlertDialogCancel.displayName = 'AlertDialogCancel';

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
