// @polsia:user-owned
import type { Metadata } from 'next';
import { AppSurface } from '@/components/custom/app-ui/app-shell';
import { AiReservePanel } from '@/components/custom/monitoring/ai-reserve-panel';
import { MonitoringDashboard } from '@/components/custom/monitoring/monitoring-dashboard';
import { SkynetPanel } from '@/components/custom/monitoring/skynet-panel';

export const metadata: Metadata = {
  title: 'Monitoraggio — Amministrazione Solco',
  description: 'Esito dei controlli automatici di Solco e storico delle ultime esecuzioni.',
};

export default function MonitoringAdminPage() {
  return (
    <>
      <MonitoringDashboard />
      {/* Riserva AI: stato dei provider gratuiti del router interno (src/lib/business/ai-reserve-*). */}
      <AppSurface>
        <AiReservePanel />
      </AppSurface>
      {/* «Skynet»: la sentinella che guarda il sito ogni minuto (src/lib/skynet/). */}
      <AppSurface>
        <SkynetPanel />
      </AppSurface>
    </>
  );
}
