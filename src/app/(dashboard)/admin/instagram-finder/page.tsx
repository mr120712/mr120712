// @polsia:user-owned

import { ServerCog } from 'lucide-react';
import type { Metadata } from 'next';
import { AdminInstagramFinder } from '@/components/custom/admin/admin-instagram-finder';

export const metadata: Metadata = {
  title: 'Trova creator Instagram',
  description: 'Ricerca con l’AI di creator Instagram pubblici, per gli amministratori.',
  robots: { index: false, follow: false },
};

export default function AdminInstagramFinderPage() {
  return (
    <main className="grid gap-6">
      <header>
        <p className="text-sm font-medium text-muted-foreground">Strumenti amministrativi</p>
        <h1 className="text-3xl font-semibold tracking-normal text-foreground">
          Trova creator Instagram
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Descrivi chi cerchi: l’AI sceglie gli hashtag, l’API ufficiale di Meta trova i post e i
          creator menzionati, ne legge i dati pubblici reali e l’AI li ordina per adattamento. Solo
          account Business/Creator; nessun dato viene salvato.
        </p>
      </header>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <AdminInstagramFinder />

        <aside className="grid gap-4">
          <section className="grid gap-2 rounded-xl border border-border/70 bg-muted/40 p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ServerCog aria-hidden="true" className="size-4 text-muted-foreground" />
              Configurazione
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Su Vercel: <code>INSTAGRAM_ACCESS_TOKEN</code> (token di lunga durata, sensibile) e{' '}
              <code>INSTAGRAM_BUSINESS_ACCOUNT_ID</code> (ID numerico dell’account Instagram
              Business di Solco). Facoltativa: <code>INSTAGRAM_GRAPH_VERSION</code>.
            </p>
            <p className="text-sm leading-6 text-muted-foreground">
              Sull’app Meta: permessi <code>instagram_basic</code>, <code>pages_show_list</code>,{' '}
              <code>pages_read_engagement</code> e la funzione{' '}
              <strong>Instagram Public Content Access</strong> (per la ricerca per hashtag). Limite
              di Meta: 30 hashtag diversi ogni 7 giorni.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
