// @polsia:user-owned

import { ServerCog } from 'lucide-react';
import type { Metadata } from 'next';
import { AdminDeepseekChat } from '@/components/custom/admin/admin-deepseek-chat';

export const metadata: Metadata = {
  title: 'DeepSeek',
  description: 'Chat privata con DeepSeek per gli amministratori.',
  robots: { index: false, follow: false },
};

export default function AdminDeepseekPage() {
  return (
    <main className="grid gap-6">
      <header>
        <p className="text-sm font-medium text-muted-foreground">Strumenti amministrativi</p>
        <h1 className="text-3xl font-semibold tracking-normal text-foreground">DeepSeek</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Chat con l’IA della Riserva Solco (in-process su Vercel). Visibile solo agli admin
          verificati: la richiesta passa dal worker yt-dlp, che inoltra al server con la sua chiave.
        </p>
      </header>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <AdminDeepseekChat />

        <aside className="grid gap-4">
          <section className="grid gap-2 rounded-xl border border-border/70 bg-muted/40 p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ServerCog aria-hidden="true" className="size-4 text-muted-foreground" />
              Configurazione
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Default: la Riserva AI di Solco (le chiavi dei provider già su Vercel, con failover).
              <code>DEEPSEEK_SOLCO_MODEL</code> fissa un modello;{' '}
              <code>DEEPSEEK_BACKEND=worker</code> usa invece il worker yt-dlp e{' '}
              <code>DEEPSEEK_ENDPOINT_URL</code>.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
