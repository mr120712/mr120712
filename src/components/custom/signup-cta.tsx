// @polsia:user-owned
'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';

export function SignupCta({
  className,
  quiet = false,
  anonymousLabel = 'Crea account gratuito',
}: {
  className?: string;
  quiet?: boolean;
  anonymousLabel?: string;
}) {
  const { data, isPending } = useSession();
  const signedIn = Boolean(data?.user);
  const href = signedIn ? '/dashboard' : '/signup';
  const label = signedIn ? 'Apri il tuo negozio' : anonymousLabel;

  if (isPending) {
    return (
      <Button asChild className={className} size="lg" variant={quiet ? 'link' : 'default'}>
        <Link href="/signup">{anonymousLabel}</Link>
      </Button>
    );
  }

  return (
    <Button asChild className={className} size="lg" variant={quiet ? 'link' : 'default'}>
      <Link href={href} aria-label={label}>
        {label}
      </Link>
    </Button>
  );
}
