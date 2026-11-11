// @polsia:user-owned
'use client';

import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { StripeCheckoutButton } from './stripe-checkout-button';

export interface StripePricingCardProps {
  title: string;
  description?: string;
  price: string;
  interval?: string;
  features?: string[];
  checkoutUrl: string;
  ctaLabel?: string;
  highlighted?: boolean;
  badge?: string;
  className?: string;
}

export function StripePricingCard({
  title,
  description,
  price,
  interval,
  features = [],
  checkoutUrl,
  ctaLabel = 'Checkout',
  highlighted = false,
  badge,
  className,
}: StripePricingCardProps) {
  return (
    <Card
      className={cn(
        'flex h-full flex-col rounded-lg',
        highlighted ? 'border-primary shadow-md' : 'shadow-sm',
        className,
      )}
    >
      <CardHeader className="gap-3">
        <div className="flex min-h-6 items-center justify-between gap-3">
          <CardTitle className="text-xl">{title}</CardTitle>
          {badge ? <Badge variant={highlighted ? 'default' : 'secondary'}>{badge}</Badge> : null}
        </div>
        {description ? <CardDescription>{description}</CardDescription> : null}
        <div className="flex items-end gap-2 pt-2">
          <span className="text-4xl font-semibold tracking-normal text-foreground">{price}</span>
          {interval ? (
            <span className="pb-1 text-sm font-medium text-muted-foreground">{interval}</span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        {features.length > 0 ? (
          <ul className="grid gap-3 text-sm">
            {features.map((feature) => (
              <li key={feature} className="flex gap-2">
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
      <CardFooter>
        <StripeCheckoutButton href={checkoutUrl} className="w-full" size="lg">
          {ctaLabel}
        </StripeCheckoutButton>
      </CardFooter>
    </Card>
  );
}
