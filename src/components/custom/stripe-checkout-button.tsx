// @polsia:user-owned
'use client';

import { ArrowRight } from 'lucide-react';
import type * as React from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';

export interface StripeCheckoutButtonProps extends Omit<ButtonProps, 'asChild' | 'children'> {
  href: string;
  children?: React.ReactNode;
}

export function StripeCheckoutButton({
  href,
  children = 'Checkout',
  disabled,
  ...props
}: StripeCheckoutButtonProps) {
  if (disabled) {
    return (
      <Button disabled {...props}>
        {children}
      </Button>
    );
  }

  return (
    <Button asChild {...props}>
      <a href={href}>
        <span>{children}</span>
        <ArrowRight aria-hidden="true" className="size-4" />
      </a>
    </Button>
  );
}
