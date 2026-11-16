// @polsia:user-owned — /contatti: chi gestisce Solco e come scrivergli. Pagina pubblica, nel footer,
// in sitemap e in llms.txt, con l'identità del titolare (brand.ts → legalContact), la casella di
// contatto con l'oggetto già pronto per ogni motivo (assistenza, pagamenti, privacy, segnalazione
// di contenuti, sicurezza), il canale ufficiale e i link a privacy, termini, stato del servizio e
// cancellazione dell'account. Niente moduli: tutto passa dall'email, così non si raccolgono dati in
// più. È anche il riferimento di /.well-known/security.txt.
import type { Metadata } from 'next';
import Link from 'next/link';
import { TelegramButton } from '@/components/custom/telegram-button';
import { Button } from '@/components/ui/button';
import { legalContact } from '@/lib/brand';
import { contactMailto, ownerStatement } from '@/lib/legal-contact';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Contatti',
  description:
    'Chi gestisce Solco e come contattarlo: assistenza, privacy, pagamenti, segnalazione di contenuti e sicurezza.',
  alternates: { canonical: '/contatti' },
};

const UPDATED = '16 novembre 2026';

export default function ContattiPage() {
  const email = legalContact.email;
  return (
    <main className={styles.page}>
      <article className={styles.content}>
        <p className={styles.eyebrow}>Solco · Contatti</p>
        <h1 className={styles.title}>Contatti e gestore del servizio</h1>
        <p className={styles.updated}>Aggiornata il {UPDATED} · pagina pubblica</p>

        <p className={styles.notice}>
          Per qualsiasi domanda su Solco scrivi a <a href={contactMailto(legalContact)}>{email}</a>:
          rispondiamo {legalContact.responseTime}. Non ci sono moduli da compilare: basta un’email.
        </p>

        <div className={styles.body}>
          <section>
            <h2>Chi gestisce Solco</h2>
            <p>{ownerStatement(legalContact)}</p>
            <p>
              Solco è un player web: non vende prodotti fisici, non mostra pubblicità e non chiede
              dati di pagamento sulle proprie pagine. I piani Premium si pagano sulle pagine sicure
              di Stripe o di PayPal e si disdicono da lì in qualsiasi momento.
            </p>
          </section>

          <section>
            <h2>Scrivici</h2>
            <ul>
              <li>
                <a href={contactMailto(legalContact, 'support')}>Assistenza e account</a>: accesso,
                riproduzione, Libreria, app Android o iPhone.
              </li>
              <li>
                <a href={contactMailto(legalContact, 'billing')}>Pagamenti e abbonamento</a>:
                addebiti, rinnovi e disdette; i piani sono in <Link href="/piani">Piani</Link>.
              </li>
              <li>
                <a href={contactMailto(legalContact, 'privacy')}>Privacy e dati</a>: accesso,
                rettifica o cancellazione dei tuoi dati (<Link href="/privacy">informativa</Link>,{' '}
                <Link href="/delete-account">eliminazione dell’account</Link>).
              </li>
              <li>
                <a href={contactMailto(legalContact, 'content')}>Segnalazione di un contenuto</a>:
                se un brano, una copertina o un testo viola i tuoi diritti, indica il link e la tua
                titolarità; dopo la verifica il contenuto viene rimosso.
              </li>
              <li>
                <a href={contactMailto(legalContact, 'security')}>Sicurezza</a>: segnala una
                vulnerabilità in modo responsabile; i riferimenti sono anche in{' '}
                <a href="/.well-known/security.txt">security.txt</a>.
              </li>
            </ul>
          </section>

          <section>
            <h2>Canale ufficiale</h2>
            <p>
              Novità, playlist e anteprime passano dal canale Telegram pubblico di Solco; lo stato
              dei sistemi è sempre visibile su <Link href="/stato">Stato del servizio</Link>. Solco
              non chiede mai password o dati di pagamento via messaggio.
            </p>
          </section>

          <section>
            <h2>Documenti</h2>
            <p>
              <Link href="/privacy">Informativa privacy</Link> ·{' '}
              <Link href="/terms">Termini del servizio</Link> ·{' '}
              <Link href="/guida">Guida per iniziare</Link>
            </p>
          </section>
        </div>

        <div className={styles.actions}>
          <Button asChild>
            <a href={contactMailto(legalContact, 'support')}>Scrivi a Solco</a>
          </Button>
          <Button asChild variant="outline">
            <Link href="/stato">Stato del servizio</Link>
          </Button>
          <TelegramButton variant="link" />
        </div>
      </article>
    </main>
  );
}
