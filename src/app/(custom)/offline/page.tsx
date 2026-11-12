// @polsia:user-owned — /offline: la pagina che il Service Worker (public/sw.js) mostra quando manca
// la rete e la pagina richiesta non è salvata. Nessun dato caricato: è HTML statico, già leggibile
// prima del JavaScript; il CSS che usa viene pre-caricato insieme alla pagina. Vedi docs/offline.md.

import { Music, WifiOff } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { RetryButton } from './retry-button';

export const metadata: Metadata = {
  title: 'Sei offline',
  description: 'Solco senza connessione: cosa funziona ancora e come riprovare.',
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-xl flex-col justify-center gap-8 px-4 py-16">
      <header className="flex flex-col items-center gap-3 text-center">
        <WifiOff aria-hidden="true" className="size-10 text-muted-foreground" />
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Sei offline
        </h1>
        <p className="text-muted-foreground">
          Non c&apos;è connessione a Internet. Solco riprende appena torni online.
        </p>
      </header>

      <section
        aria-labelledby="offline-still-works"
        className="rounded-xl border border-border bg-card p-5 text-card-foreground"
      >
        <h2
          id="offline-still-works"
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Cosa funziona ancora
        </h2>
        <div className="mt-4 flex gap-3">
          <Music aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">
              <Link
                href="/library#la-tua-musica"
                prefetch={false}
                className="underline underline-offset-4 hover:text-primary"
              >
                La tua musica
              </Link>
            </p>
            <p className="text-sm text-muted-foreground">
              I brani che aggiungi dal tuo dispositivo (MP3, M4A…) restano solo sul telefono e
              suonano anche senza rete. La trovi in cima alla Libreria.
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Ricerca, radio, podcast e brani in streaming tornano quando sei di nuovo online.
        </p>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        <RetryButton />
        <Button asChild variant="outline" size="lg">
          <Link href="/library" prefetch={false}>
            Apri la Libreria
          </Link>
        </Button>
      </div>
    </main>
  );
}
