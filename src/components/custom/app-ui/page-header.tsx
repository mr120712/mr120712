// @polsia:user-owned
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="app-ui-page-header">
      <div>
        {breadcrumb && <div className="app-ui-breadcrumb">{breadcrumb}</div>}
        <h1>{title}</h1>
        {description && <div className="app-ui-description">{description}</div>}
      </div>
      {actions && <div className="app-ui-actions">{actions}</div>}
    </header>
  );
}
