// @polsia:user-owned
import type { Metadata } from 'next';
import { MonitoringDashboard } from '@/components/custom/monitoring/monitoring-dashboard';

export const metadata: Metadata = {
  title: 'Monitoraggio — Amministrazione Solco',
  description: 'Esito dei controlli automatici di Solco e storico delle ultime esecuzioni.',
};

export default function MonitoringAdminPage() {
  return <MonitoringDashboard />;
}
