// @polsia:user-owned — /impostazioni: preferenze normali per tutti gli utenti (anche ospiti). Sono
// interruttori salvati per dispositivo (localStorage): niente login, niente dati sul server. Con
// l'accesso, in cima la sezione «Account» con l'email e, se serve, il link di verifica.
import { BookOpen, Settings } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountEmailSettings } from '@/components/custom/settings/account-email-settings';
import { SettingsPanel } from '@/components/custom/settings/settings-panel';

export const metadata: Metadata = {
  title: 'Impostazioni',
  description:
    'Preferenze di Solco salvate su questo dispositivo: autoplay continuo e risparmio dati.',
  // Pagina pubblica ed elencata nella sitemap (src/lib/nav.ts): niente noindex, altrimenti Search
  // Console la segnala come «URL inviato contrassegnato come noindex». Google non è mai loggato,
  // quindi non vede mai la sezione «Account».
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
        {/* Per chi è alle prime armi: la guida passo per passo (pubblica, come questa pagina). */}
        <p className="text-sm text-muted-foreground">
          Prima volta su Solco?{' '}
          <Link
            href="/guida"
            className="inline-flex min-h-11 items-center gap-1.5 font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          >
            <BookOpen aria-hidden="true" className="size-4" />
            Guida per iniziare
          </Link>
        </p>
      </header>

      {/* Solo con l'accesso: l'email e, se non è verificata, il link di verifica. */}
      <AccountEmailSettings />
      <SettingsPanel />
    </main>
  );
}
