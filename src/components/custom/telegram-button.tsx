// @polsia:user-owned — link al canale Telegram di Solco (card in Home, footer, menu mobile).
//
// No hooks and no 'use client': the Home (a Server Component) renders the card, while
// the client SiteNav renders the footer link and the mobile-menu item. External link,
// so a plain <a> (no next/link) that always opens in a new tab without `window.opener`.

import { ArrowUpRight, Send } from 'lucide-react';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { socialLinks } from '@/lib/brand';
import { cn } from '@/lib/utils';

export type TelegramButtonVariant = 'card' | 'link' | 'menu';

type TelegramButtonProps = {
  variant: TelegramButtonVariant;
  className?: string;
  /** Lets a caller react to the click (e.g. close the mobile menu Sheet). */
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
};

const TELEGRAM_URL = socialLinks.telegram;

/** Screen-reader suffix: the visible label stays first, so "label in name" holds. */
const NEW_TAB_NOTICE = '(si apre in una nuova scheda)';

function ScreenReaderSuffix({ text }: { text: string }) {
  return <span className="sr-only">{` ${text}`}</span>;
}

const CARD_HEADING_ID = 'telegram-card-heading';

/**
 * Telegram channel link in three shapes:
 * - `card`: prominent Telegram-blue panel with title, copy and CTA (Home feed);
 * - `link`: inline text link with a small icon (footers);
 * - `menu`: full-width ghost item (mobile menu Sheet).
 *
 * Colours: the icon tile uses Telegram blue #229ED9 (white icon 3.0:1, non-text
 * minimum); the text sits on deeper Telegram blues (#1B6FA8 → #145A8C) so white copy
 * stays at AA (≥ 4.7:1), with a light-blue #2AABEE edge.
 */
export function TelegramButton({ variant, className, onClick }: TelegramButtonProps) {
  if (variant === 'link') {
    return (
      <Button
        asChild
        variant="link"
        size="sm"
        className={cn('gap-1.5 [&_svg]:size-3.5', className)}
      >
        <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer" onClick={onClick}>
          <Send aria-hidden="true" />
          Telegram
          <ScreenReaderSuffix text={NEW_TAB_NOTICE} />
        </a>
      </Button>
    );
  }

  if (variant === 'menu') {
    return (
      <Button asChild variant="ghost" className={cn('w-full justify-start', className)}>
        <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer" onClick={onClick}>
          <Send aria-hidden="true" />
          Canale Telegram
          <ScreenReaderSuffix text={NEW_TAB_NOTICE} />
        </a>
      </Button>
    );
  }

  return (
    <section
      aria-labelledby={CARD_HEADING_ID}
      className={cn(
        'grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3.5 rounded-[calc(var(--radius)+6px)] border border-[#2AABEE]/50 bg-[linear-gradient(135deg,#1B6FA8_0%,#145A8C_100%)] px-[18px] py-4 text-white min-[621px]:grid-cols-[48px_minmax(0,1fr)_auto]',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="grid size-10 place-items-center rounded-xl bg-[#229ED9] text-white ring-1 ring-white/25 min-[621px]:size-12"
      >
        <Send className="size-5 -translate-x-px translate-y-px min-[621px]:size-6" />
      </span>
      <div className="min-w-0">
        <h2 id={CARD_HEADING_ID} className="m-0 text-base font-[650] leading-snug text-white">
          Solco su Telegram
        </h2>
        <p className="mt-0.5 text-[13px] text-[#E3F2FC]">
          Novità, playlist e anteprime: unisciti al canale.
        </p>
      </div>
      <Button
        asChild
        className="col-span-full justify-self-start bg-white text-[#0F5C8F] shadow-sm hover:bg-[#E6F4FC] focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#1B6FA8] min-[621px]:col-span-1"
      >
        <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer" onClick={onClick}>
          Unisciti al canale
          <ScreenReaderSuffix text={`Telegram ${NEW_TAB_NOTICE}`} />
          <ArrowUpRight aria-hidden="true" />
        </a>
      </Button>
    </section>
  );
}
