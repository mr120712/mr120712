// @polsia:user-owned — opt-in application compositions; no auth or data ownership.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type AppSurfaceProps = {
  children: ReactNode;
  density?: 'comfortable' | 'compact';
  className?: string;
};

/** Use inside a module's existing dashboard/admin shell to avoid duplicate navigation. */
export function AppSurface({ children, density = 'comfortable', className }: AppSurfaceProps) {
  return (
    <div className={cn('app-ui', className)} data-density={density}>
      {children}
    </div>
  );
}

/** Mount once in an area layout. Authentication and route authorization stay with the caller. */
export function AppShell({
  brand,
  navigation,
  navigationLabel,
  header,
  footer,
  children,
  density,
  className,
}: AppSurfaceProps & {
  brand: ReactNode;
  navigation: ReactNode;
  navigationLabel: string;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <AppSurface density={density} className={cn('app-ui-shell', className)}>
      <aside className="app-ui-sidebar">
        <div className="app-ui-brand">{brand}</div>
        <nav aria-label={navigationLabel}>{navigation}</nav>
        {footer && <div className="app-ui-sidebar-footer">{footer}</div>}
      </aside>
      <div className="app-ui-workspace">
        {header && <header className="app-ui-topbar">{header}</header>}
        <main className="app-ui-content">{children}</main>
      </div>
    </AppSurface>
  );
}
