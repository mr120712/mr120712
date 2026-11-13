// @polsia:user-owned
import { ArrowRight, AudioLines, Bot, Clapperboard, Send } from 'lucide-react';
import Link from 'next/link';
import { RateLimitNotice } from '@/components/custom/admin/rate-limit-notice';
import { Button } from '@/components/ui/button';

export default function AdminPage() {
  return (
    <div className="grid gap-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Spazio amministrativo</p>
        <h1 className="text-3xl font-semibold tracking-normal text-foreground">Panoramica</h1>
      </div>
      <section className="grid max-w-xl gap-4">
        <article className="grid content-start gap-3 rounded-xl border border-border bg-card p-6">
          <AudioLines aria-hidden="true" className="size-5 text-primary" />
          <h2 className="font-semibold text-card-foreground">Diritti musicali</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Registra fonti audio private e prove correnti per il brano esatto. L’accesso resta
            chiuso finché Pro e autorizzazione non risultano verificati dal server.
          </p>
          <Button asChild variant="outline" className="mt-1 justify-between">
            <Link href="/admin/music-rights">
              Gestisci fonti e prove
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </article>
        <article className="grid content-start gap-3 rounded-xl border border-border bg-card p-6">
          <Bot aria-hidden="true" className="size-5 text-primary" />
          <h2 className="font-semibold text-card-foreground">Assistente IA</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Indaga problemi in più turni, esplicita le evidenze e segnala i dati che non può
            verificare.
          </p>
          <Button asChild variant="outline" className="mt-1 justify-between">
            <Link href="/admin/assistente">
              Apri assistente
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </article>
        <article className="grid content-start gap-3 rounded-xl border border-border bg-card p-6">
          <Clapperboard aria-hidden="true" className="size-5 text-primary" />
          <h2 className="font-semibold text-card-foreground">Video TikTok</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Scegli i video TikTok pubblici mostrati in Solco e scrivi l’annuncio con l’IA (Claude
            5.5): gancio, didascalia, hashtag e copione, pronti da girare.
          </p>
          <Button asChild variant="outline" className="mt-1 justify-between">
            <Link href="/admin/tiktok">
              Apri Video TikTok
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </article>
        <article className="grid content-start gap-3 rounded-xl border border-border bg-card p-6">
          <Send aria-hidden="true" className="size-5 text-primary" />
          <h2 className="font-semibold text-card-foreground">Annunci su Telegram</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Pubblica sul canale un avviso con la riga di sintesi del commit e la versione. Nessun
            dato sensibile.
          </p>
          <Button asChild variant="outline" className="mt-1 justify-between">
            <Link href="/admin/telegram">
              Pubblica un annuncio
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </article>
      </section>
      <RateLimitNotice />
    </div>
  );
}
