// @polsia:user-owned — fonde il REGISTRO statico dei provider della riserva (reserveKnownProviders) con
// lo stato reale: quali hanno la chiave (activeProviders) e quali rispondono (probeProviders). Alimenta
// il pannello admin «Riserva AI · provider». Nessun segreto: mai la chiave, solo "presente/assente" e
// l'HTTP della sonda /models. La sonda non spende token.
import 'server-only';
import {
  activeProviders,
  discoverProviderModels,
  reserveKnownProviders,
} from '@/lib/business/ai-reserve-connector.server';
import { magnetapiAgentsView } from '@/lib/business/magnetapi-status.server';
import type {
  ReserveProviderStatusName,
  ReserveProvidersOverview,
  ReserveProviderView,
} from '@/lib/contracts/ai-reserve-providers';

type Env = Record<string, string | undefined>;

/** Stato di ogni provider conosciuto: configurato? risponde? e come aggiungerlo se manca. */
export async function reserveProvidersOverview(
  env: Env = process.env,
  now: Date = new Date(),
): Promise<ReserveProvidersOverview> {
  const known = reserveKnownProviders(env);
  const configuredIds = new Set(activeProviders(env).map((provider) => provider.id));
  // Cerca automatica: interroga /models dei soli provider ATTIVI e scopre i modelli serviti ADESSO
  // (oltre allo stato). Se fallisce del tutto, trattiamo i configurati come "da verificare" (failing)
  // senza rompere il pannello e senza modelli scoperti.
  // In parallelo: la cerca della riserva e la sonda di MagnetAPI (solo agenti, fuori dalla riserva).
  const [discoveries, magnetapi] = await Promise.all([
    discoverProviderModels(env).catch(() => []),
    magnetapiAgentsView(env).catch(() => null),
  ]);
  const byId = new Map(discoveries.map((discovery) => [discovery.id, discovery]));

  const providers: ReserveProviderView[] = known.map((provider) => {
    const configured = configuredIds.has(provider.id);
    const found = byId.get(provider.id);
    const status: ReserveProviderStatusName = !configured
      ? 'not_configured'
      : found?.ok
        ? 'live'
        : 'failing';
    return {
      id: provider.id,
      label: provider.label,
      keyVar: provider.keyVar,
      signupUrl: provider.signupUrl,
      models: provider.models,
      configured,
      status,
      httpStatus: found?.status ?? null,
      discoveredModels: found?.models ?? [],
      discoveredCount: found?.modelCount ?? 0,
    };
  });

  return {
    providers,
    liveCount: providers.filter((provider) => provider.status === 'live').length,
    configuredCount: providers.filter((provider) => provider.configured).length,
    total: providers.length,
    discoveredTotal: providers.reduce((sum, provider) => sum + provider.discoveredCount, 0),
    agents: magnetapi ? [magnetapi] : [],
    checkedAt: now.toISOString(),
  };
}
