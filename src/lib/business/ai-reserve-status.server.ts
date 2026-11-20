// @polsia:user-owned — fonde il REGISTRO statico dei provider della riserva (reserveKnownProviders) con
// lo stato reale: quali hanno la chiave (activeProviders) e quali rispondono (probeProviders). Alimenta
// il pannello admin «Riserva AI · provider». Nessun segreto: mai la chiave, solo "presente/assente" e
// l'HTTP della sonda /models. La sonda non spende token.
import 'server-only';
import {
  activeProviders,
  probeProviders,
  reserveKnownProviders,
} from '@/lib/business/ai-reserve-connector.server';
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
  // La sonda interroga /models dei soli provider ATTIVI; se fallisce del tutto, trattiamo i configurati
  // come "da verificare" (failing) senza rompere il pannello.
  const probes = await probeProviders(env).catch(() => []);
  const probeById = new Map(probes.map((probe) => [probe.id, probe]));

  const providers: ReserveProviderView[] = known.map((provider) => {
    const configured = configuredIds.has(provider.id);
    const probe = probeById.get(provider.id);
    const status: ReserveProviderStatusName = !configured
      ? 'not_configured'
      : probe?.ok
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
      httpStatus: probe?.status ?? null,
    };
  });

  return {
    providers,
    liveCount: providers.filter((provider) => provider.status === 'live').length,
    configuredCount: providers.filter((provider) => provider.configured).length,
    total: providers.length,
    checkedAt: now.toISOString(),
  };
}
