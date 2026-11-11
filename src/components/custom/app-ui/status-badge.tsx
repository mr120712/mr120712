// @polsia:user-owned
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

export function StatusBadge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'positive' | 'warning' | 'critical' | 'info';
}) {
  return (
    <Badge
      variant="outline"
      className="app-ui-status font-medium text-[color:var(--app-status-color)]"
      data-tone={tone}
    >
      <span aria-hidden="true" />
      {children}
    </Badge>
  );
}
