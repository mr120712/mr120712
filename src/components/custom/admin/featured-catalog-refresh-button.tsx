// @polsia:user-owned — pulsante «Aggiorna ora» della pagina admin «Diritti e testi»: dopo aver
// aggiunto o tolto brani (o cambiato diritti.json) dal pannello Vercel Blob, li fa comparire subito
// ovunque (Home, ricerca, pagine d'artista, link diretti) invece di aspettare il controllo
// automatico. Chiama POST /api/admin/featured-rights/refresh e lo conferma con un avviso
// (toast); se lo store Blob non ha risposto all'elenco (`stale`) lo dice invece di confermare; un
// errore o il limite raggiunto arrivano con il messaggio del server. Un diritti.json PUBBLICO non
// è coperto: il CDN di Vercel Blob può servirne la copia precedente per qualche minuto.
'use client';

import { LoaderCircle, Zap } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { AdminFeaturedRefreshResponseSchema } from '@/lib/contracts/admin-featured-rights';

export const FEATURED_REFRESH_ENDPOINT = '/api/admin/featured-rights/refresh';
export const FEATURED_REFRESH_SUCCESS =
  'Brani in evidenza aggiornati: compariranno ovunque entro un minuto';
export const FEATURED_REFRESH_STALE =
  'Lo store Blob non ha risposto: i brani in evidenza si aggiorneranno appena torna disponibile. Riprova tra poco.';
const MESSAGE_MAX = 300;

const ERROR_CODE_TEXT: Record<string, string> = {
  unauthorized: 'La sessione è scaduta: accedi di nuovo.',
  forbidden: 'Serve un account amministratore con email verificata.',
  forbidden_origin: 'Richiesta rifiutata: ricarica la pagina e riprova.',
  session_unavailable: 'Non riesco a verificare la sessione in questo momento. Riprova tra poco.',
};

function refreshFailure(error: unknown): string {
  if (error instanceof ZodError) return 'La risposta del server non è nel formato atteso.';
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete e riprova.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown; error?: unknown })
      : null;
  if (typeof cause?.message === 'string' && cause.message.trim()) {
    return cause.message.trim().slice(0, MESSAGE_MAX);
  }
  const code = cause?.error;
  if (typeof code === 'string' && Object.hasOwn(ERROR_CODE_TEXT, code)) {
    return ERROR_CODE_TEXT[code] ?? '';
  }
  return 'Non riesco ad aggiornare i brani in evidenza. Riprova tra poco.';
}

export function FeaturedCatalogRefreshButton({ onRefreshed }: { onRefreshed?: () => void }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const refresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await apiFetch(FEATURED_REFRESH_ENDPOINT, {
        method: 'POST',
        schema: AdminFeaturedRefreshResponseSchema,
      });
      // `stale`: l'elenco dello store è fallito, resta l'ultimo buono. Niente conferma falsa.
      if (result.stale) toast.warning(FEATURED_REFRESH_STALE);
      else toast.success(FEATURED_REFRESH_SUCCESS);
      onRefreshed?.();
    } catch (error) {
      toast.error(refreshFailure(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => void refresh()}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      title="Fa comparire subito in Home, ricerca e pagine d'artista i brani aggiunti o tolti nello store Blob (con diritti.json pubblico le modifiche ai diritti possono tardare qualche minuto)"
      className="aria-disabled:cursor-progress aria-disabled:opacity-70"
    >
      {busy ? (
        <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
      ) : (
        <Zap aria-hidden="true" />
      )}
      Aggiorna ora
    </Button>
  );
}
