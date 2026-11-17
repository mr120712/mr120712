// @polsia:user-owned
import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Eliminazione account',
  description: 'Come chiedere l’eliminazione dell’account Solco e dei dati associati.',
  alternates: { canonical: '/delete-account' },
};

export default function DeleteAccountPage() {
  return (
    <main className={styles.page}>
      <article className={styles.content}>
        <p className={styles.eyebrow}>Solco · I tuoi dati</p>
        <h1 className={styles.title}>Richiedi l’eliminazione del tuo account</h1>
        <p className={styles.updated}>Pagina pubblica · non richiede l’accesso</p>

        <p className={styles.notice}>
          Se puoi accedere al tuo account, apri il profilo e usa il comando di eliminazione:
          l’account, le sessioni e i dati associati vengono rimossi dal database Solco in un’unica
          operazione. La cancellazione è definitiva.
        </p>

        <div className={styles.body}>
          <section>
            <h2>Richiesta dal sito o dall’app Android</h2>
            <p>
              Accedi a Solco, apri il tuo profilo e conferma l’eliminazione digitando “ELIMINA
              ACCOUNT”. La Trusted Web Activity Android apre il sito Solco e usa lo stesso percorso.
            </p>
            <Button asChild>
              <Link href="/login?callbackURL=%2Fprofile">Accedi per eliminare l’account</Link>
            </Button>
          </section>

          <section>
            <h2>Se non riesci ad accedere</h2>
            <p>
              Invia la richiesta da{' '}
              <Link href="mailto:solcomusic@polsia.app?subject=Richiesta%20eliminazione%20account%20Solco">
                solcomusic@polsia.app
              </Link>
              , preferibilmente dall’indirizzo email associato all’account. Se non hai più accesso a
              quell’indirizzo, spiega il problema e il proprietario verificherà la richiesta prima
              di intervenire. Non inviare password o codici di accesso. Questa casella è il canale
              di richiesta, non un accesso automatico all’account.
            </p>
          </section>

          <section>
            <h2>Dati coinvolti</h2>
            <p>
              La cancellazione autenticata rimuove account e sessioni, accessi collegati (Google,
              Apple, Spotify, TikTok, bot Telegram), profilo e relazioni community, conversazioni
              private, diario, libreria e cronologia d’ascolto, premi e inviti, segnalazioni fatte e
              i brani che hai pubblicato, con i loro file. Restano solo le registrazioni di
              abbonamenti e pagamenti (identificativi, senza nome né email), per gli obblighi
              fiscali. Eventuali dati mantenuti da fornitori esterni e copie di backup seguono i
              tempi indicati nell’informativa.
            </p>
            <p>
              Un abbonamento attivo non si chiude da solo con l’account: disdicilo prima da
              «Gestisci abbonamento» o dal tuo account PayPal.
            </p>
            <p>
              Per conoscere i dati trattati e le informazioni ancora da confermare, consulta l’
              <Link href="/privacy">informativa privacy</Link>.
            </p>
          </section>
        </div>

        <div className={styles.actions}>
          <Button asChild variant="outline">
            <Link href="/privacy">Informativa privacy</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/">Torna a Solco</Link>
          </Button>
        </div>
      </article>
    </main>
  );
}
