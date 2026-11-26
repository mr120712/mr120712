// @polsia:user-owned — indirizzi dell'owner che Skynet non manda mai alla verifica.
// Due fonti: SKYNET_TRUSTED_IPS (fissa, su Vercel) e quelli registrati in automatico quando un
// amministratore verificato apre /admin (SkynetState.trustedIps, 7 giorni ciascuno). Puro: testabile.

export const TRUST_DAYS = 7;
export const MAX_TRUSTED = 10;
const DAY_MS = 86_400_000;

export type TrustedMap = Record<string, string>;

export function parseTrusted(value: unknown, now: Date): TrustedMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: TrustedMap = {};
  for (const [ip, until] of Object.entries(value as Record<string, unknown>)) {
    if (typeof until !== 'string') continue;
    const time = Date.parse(until);
    if (Number.isFinite(time) && time > now.getTime()) out[ip] = new Date(time).toISOString();
  }
  return out;
}

/** Aggiunge (o rinnova) un indirizzo; tiene i più recenti, al massimo MAX_TRUSTED. */
export function trustIp(
  current: TrustedMap,
  ip: string,
  now: Date,
): { map: TrustedMap; changed: boolean } {
  const until = new Date(now.getTime() + TRUST_DAYS * DAY_MS).toISOString();
  const existing = current[ip];
  // Rinnovo al massimo una volta al giorno: niente scrittura a ogni pagina aperta.
  if (existing && Date.parse(existing) - now.getTime() > (TRUST_DAYS - 1) * DAY_MS) {
    return { map: current, changed: false };
  }
  const entries = Object.entries({ ...current, [ip]: until })
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, MAX_TRUSTED);
  return { map: Object.fromEntries(entries), changed: true };
}
