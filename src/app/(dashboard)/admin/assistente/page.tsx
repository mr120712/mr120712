// @polsia:user-owned

import { ShieldAlert } from 'lucide-react';
import type { Metadata } from 'next';
import { AdminAssistant } from '@/components/custom/admin/admin-assistant';

export const metadata: Metadata = {
  title: 'Assistente admin',
  description: 'Assistenza IA privata per diagnosi e operazioni amministrative Solco.',
};

export default function AdminAssistantPage() {
  return (
    <main className="grid gap-6">
      <header>
        <p className="text-sm font-medium text-muted-foreground">Strumenti amministrativi</p>
        <h1 className="text-3xl font-semibold tracking-normal text-foreground">Assistente IA</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Un supporto conversazionale per ragionare sui problemi e trovare i passaggi amministrativi
          disponibili. Le risposte distinguono le informazioni note da quelle che non posso
          verificare.
        </p>
      </header>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <AdminAssistant />

        <aside className="grid gap-4">
          <section className="grid gap-2 rounded-xl border border-border/70 bg-muted/40 p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ShieldAlert aria-hidden="true" className="size-4 text-muted-foreground" />
              Limiti di verifica
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              L’assistente non legge log, account o cronologie e non riceve credenziali. Quando
              servono questi dati, lo dichiarerà senza inventare una verifica.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
