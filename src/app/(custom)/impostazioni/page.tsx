// @polsia:user-owned — /impostazioni: preferenze normali per tutti gli utenti (anche ospiti). Sono
// interruttori salvati per dispositivo (localStorage): niente login, niente dati sul server.
import { Settings } from 'lucide-react';
import type { Metadata } from 'next';
import { SettingsPanel } from '@/components/custom/settings/settings-panel';

export const metadata: Metadata = {
  title: 'Impostazioni',
  description:
    'Preferenze di Solco salvate su questo dispositivo: autoplay continuo e risparmio dati.',
  robots: { index: false, follow: false },
};

export default function ImpostazioniPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Settings aria-hidden="true" className="size-5" />
          <span className="text-sm font-semibold uppercase tracking-wide">Impostazioni</span>
        </div>
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Le tue preferenze
        </h1>
        <p className="text-muted-foreground">
          Valgono su questo dispositivo e si applicano subito. Nessun account necessario.
        </p>
      </header>

      <SettingsPanel />
    </main>
  );
}
