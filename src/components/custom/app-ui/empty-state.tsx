// @polsia:user-owned
import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="app-ui-empty">
      {icon && <div aria-hidden="true">{icon}</div>}
      <h3>{title}</h3>
      {description && <div className="app-ui-description">{description}</div>}
      {action}
    </div>
  );
}
