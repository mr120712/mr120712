// @polsia:user-owned
import type { ReactNode } from 'react';

export function MetricGrid({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="app-ui-metrics" aria-label={label}>
      {children}
    </section>
  );
}

/** Values and trends come from real application data; no generated claims or placeholder charts. */
export function MetricCard({
  label,
  value,
  detail,
  trend,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  trend?: ReactNode;
}) {
  return (
    <div className="app-ui-metric">
      <dl>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </dl>
      {detail && <div className="app-ui-metric-detail">{detail}</div>}
      {trend && <div className="app-ui-metric-trend">{trend}</div>}
    </div>
  );
}
