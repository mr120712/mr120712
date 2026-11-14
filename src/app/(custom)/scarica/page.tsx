// @polsia:user-owned — /scarica: "Scarica da URL". Incolli un link e scarichi il file sul dispositivo,
// MA solo da sorgenti consentite: i tuoi brani caricati su Solco (verificati per proprietario) o brani
// Audius resi scaricabili dall'artista. I link esterni (YouTube, Spotify, siti vari) sono rifiutati:
// Solco non fa da proxy per il ripping di contenuti di terzi. Il download vero passa dalla rotta
// same-origin /api/music/download/by-url (login, limitata, SSRF-safe, tetto 50 MB).
import { Download, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DownloadByUrl } from '@/components/custom/music/download-by-url';

export const metadata: Metadata = {
  title: 'Scarica da URL',
  description:
    'Incolla il link di un tuo brano caricato su Solco o di un brano Audius scaricabile e salvalo sul dispositivo.',
  robots: { index: false, follow: false },
};

export default function ScaricaDaUrlPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-12">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Download aria-hidden="true" className="size-5" />
          <span className="text-sm font-semibold uppercase tracking-wide">Scarica da URL</span>
        </div>
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Scarica un brano dal suo link
        </h1>
        <p className="text-muted-foreground">
          Incolla il link e lo salvi sul dispositivo. Funziona solo con fonti consentite: niente
          ripping da servizi di terzi.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
        <DownloadByUrl />
        <p id="download-url-hint" className="mt-3 text-sm text-muted-foreground">
          Serve l&apos;accesso. Il download è limitato e il file può pesare al massimo 50 MB.
        </p>
      </section>

      <section
        aria-labelledby="scarica-consentiti"
        className="rounded-xl border border-border bg-muted/40 p-5"
      >
        <h2 id="scarica-consentiti" className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck aria-hidden="true" className="size-4 text-muted-foreground" />
          Cosa posso scaricare
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li>
            • <strong className="text-foreground">I tuoi brani</strong> caricati su Solco (
            <Link href="/pubblica" className="underline underline-offset-2">
              Pubblica
            </Link>
            ): il link è il tuo, verificato per proprietario.
          </li>
          <li>
            • <strong className="text-foreground">Brani Audius</strong> che l&apos;artista ha reso
            scaricabili sotto la Open Music License.
          </li>
          <li>
            I link esterni (YouTube, Spotify, siti vari) non sono consentiti: Solco non scarica
            contenuti di terzi.
          </li>
        </ul>
      </section>
    </main>
  );
}
