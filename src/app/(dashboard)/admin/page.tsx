// @polsia:user-owned
import {
  ArrowRight,
  AudioLines,
  AudioWaveform,
  BarChart3,
  Bot,
  Clapperboard,
  FileCheck2,
  Send,
  UserCog,
  Users,
} from 'lucide-react';
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
          <Users aria-hidden="true" className="size-5 text-primary" />
          <h2 className="font-semibold text-card-foreground">Iscritti</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Quanti account ci sono, i nuovi delle ultime 24 ore, 7 e 30 giorni e l’andamento giorno
            per giorno. Solo numeri aggregati, nessun dato personale.
          </p>
          <Button asChild variant="outline" className="mt-1 justify-between">
            <Link href="/admin/iscritti">
              Apri iscritti
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </article>
        <article className="grid content-start gap-3 rounded-xl border border-border bg-card p-6">
          <BarChart3 aria-hidden="true" className="size-5 text-primary" />
          <h2 className="font-semibold text-card-foreground">Visitatori</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Quante persone aprono le pagine di Solco oggi, negli ultimi 7 e 30 giorni, le pagine più
            viste, i Paesi, i siti di provenienza e i dispositivi. Conteggio senza cookie: solo
            numeri aggregati, nessun indirizzo IP.
          </p>
          <Button asChild variant="outline" className="mt-1 justify-between">
            <Link href="/admin/visitatori">
              Apri visitatori
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </article>
        <article className="grid content-start gap-3 rounded-xl border border-border bg-card p-6">
          <UserCog aria-hidden="true" className="size-5 text-primary" />
          <h2 className="font-semibold text-card-foreground">Gestione account</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Ogni account con il suo UID, il modo di accesso e il Premium attivo. Da qui concedi o
            revochi il Premium illimitato a un’email.
          </p>
          <Button asChild variant="outline" className="mt-1 justify-between">
            <Link href="/admin/account">
              Apri gestione account
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </article>
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
          <FileCheck2 aria-hidden="true" className="size-5 text-primary" />
          <h2 className="font-semibold text-card-foreground">Diritti e testi</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Perché un brano in evidenza è (o non è) ricercabile, gli errori di diritti.json voce per
            voce e se il testo dei brani dichiarati c’è. La diagnosi non mostra il testo; per i
            brani con “testo”: true puoi trascriverlo con l’IA.
          </p>
          <Button asChild variant="outline" className="mt-1 justify-between">
            <Link href="/admin/diritti-testi">
              Apri diritti e testi
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
          <AudioWaveform aria-hidden="true" className="size-5 text-primary" />
          <h2 className="font-semibold text-card-foreground">audio.com nella ricerca</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Collega l’account audio.com che il server usa per aggiungere i suoi brani alla ricerca,
            con licenza e attribuzione. Mostra lo stato del collegamento e l’ultimo problema.
          </p>
          <Button asChild variant="outline" className="mt-1 justify-between">
            <Link href="/admin/audiocom">
              Apri audio.com
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
