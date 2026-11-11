// @polsia:user-owned
import type { ReactNode } from 'react';

/** Compose labelled Input/Select/Tabs controls. State and API calls belong to the page. */
export function ListToolbar({
  filters,
  search,
  actions,
}: {
  filters?: ReactNode;
  search?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="app-ui-list-toolbar">
      <div className="app-ui-filters">{filters}</div>
      <div className="app-ui-list-tools">
        {search}
        {actions}
      </div>
    </div>
  );
}
