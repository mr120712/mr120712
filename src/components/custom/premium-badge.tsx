// @polsia:user-owned — lo stato «Premium» degli account Premium, in due forme:
// - `PremiumBadge`: pillola con il bordo nel gradiente del brand (violetto → magenta → ambra), stella
//   dorata piena e la scritta «Premium», con la fonte facoltativa («Premium · Illimitato»). Un
//   riflesso le passa sopra una volta all'arrivo, mai con «riduci movimento».
// - `PremiumStarDot`: la stessa stella in un bollino, da sovrapporre a un'icona o a un avatar (il
//   contenitore deve essere `position: relative`). È decorativa: chi la usa mette «Premium» nel nome
//   accessibile dell'elemento (es. l'aria-label del pulsante del profilo).
// - `PremiumAvatarRing`: anello nel gradiente del brand attorno a un avatar, con la stellina in basso
//   a destra; senza Premium lo stesso spazio vuoto (niente salti quando lo stato arriva).
// La stella non dice nulla da sola ai lettori di schermo: il significato è nel testo.
import { Star } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import styles from './premium-badge.module.css';

export function PremiumBadge({
  size = 'md',
  detail,
  className,
}: {
  /** `sm` negli elenchi (es. «Gestione account»), `md` accanto a un titolo. */
  size?: 'sm' | 'md';
  /** Da dove viene il Premium (es. «Illimitato»), dopo un punto separatore. */
  detail?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(styles.badge, size === 'sm' ? styles.sm : styles.md, className)}
      data-premium-badge=""
    >
      <Star aria-hidden="true" className={styles.star} fill="currentColor" strokeWidth={1.5} />
      <span className={styles.label}>Premium</span>
      {detail ? (
        <span className={styles.detail}>
          <span aria-hidden="true" className={styles.separator}>
            {' · '}
          </span>
          {detail}
        </span>
      ) : null}
    </span>
  );
}

export function PremiumStarDot({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn(styles.starDot, className)} data-premium-star="">
      <Star className={styles.starDotIcon} fill="currentColor" strokeWidth={1.5} />
    </span>
  );
}

export function PremiumAvatarRing({
  premium,
  children,
}: {
  premium: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn(styles.avatarRing, premium && styles.avatarRingPremium)}>
      {children}
      {premium ? <PremiumStarDot className={styles.avatarStar} /> : null}
    </div>
  );
}
