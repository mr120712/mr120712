// @polsia:user-owned — installa Solco su Android (APK) e su iPhone/iPad (profilo, senza App Store).
import { Apple, Download, Smartphone } from 'lucide-react';
import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import styles from './app.module.css';

export const metadata: Metadata = {
  title: 'Installa l’app',
  description: 'Installa Solco su Android o su iPhone e iPad, senza passare dagli store.',
  alternates: { canonical: '/app' },
};

const androidSteps = [
  'Tocca “Scarica l’APK” dal telefono Android.',
  'Apri il file scaricato. Se Android lo chiede, consenti al browser di installare app sconosciute.',
  'Tocca “Installa” e apri Solco dalla schermata Home.',
];

const iosSteps = [
  'Apri questa pagina con Safari sull’iPhone o sull’iPad e tocca “Scarica il profilo”.',
  'Tocca “Consenti” quando Safari chiede di scaricare il profilo di configurazione.',
  'Apri Impostazioni: in alto compare “Profilo scaricato”. Toccalo, poi “Installa” e inserisci il codice del telefono.',
  'L’icona Solco appare nella schermata Home e si apre a schermo intero, come un’app.',
];

export default function InstallAppPage() {
  return (
    <main className={styles.page}>
      <h1>Installa Solco</h1>
      <p className={styles.lead}>
        Player, Libreria, radio e piani a schermo intero, senza passare dagli store. L’app si
        aggiorna da sola insieme al sito.
      </p>

      <section className={styles.platform} id="android" aria-labelledby="android-heading">
        <div className={styles.icon} aria-hidden="true">
          <Smartphone />
        </div>
        <h2 id="android-heading">Android</h2>
        <Button asChild size="lg">
          <a href="/solco.apk" download="solco.apk">
            <Download aria-hidden="true" />
            Scarica l’APK
          </a>
        </Button>
        <p className={styles.meta}>Versione 1.1.0 · Android 7.0 o successivo</p>
        <ol className={styles.steps}>
          {androidSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className={styles.meta}>
          Hai già installato una versione precedente di Solco? Disinstallala prima: la nuova app è
          firmata con una chiave diversa e Android non può aggiornarla.
        </p>
      </section>

      <section className={styles.platform} id="iphone" aria-labelledby="iphone-heading">
        <div className={styles.icon} aria-hidden="true">
          <Apple />
        </div>
        <h2 id="iphone-heading">iPhone e iPad</h2>
        <Button asChild size="lg">
          <a href="/ios/solco.mobileconfig">
            <Download aria-hidden="true" />
            Scarica il profilo
          </a>
        </Button>
        <p className={styles.meta}>iOS 15 o successivo · funziona solo con Safari</p>
        <ol className={styles.steps}>
          {iosSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className={styles.meta}>
          Il profilo non installa software: aggiunge solo l’icona di Solco. iOS lo segnala come “non
          verificato” perché non è firmato da Apple; puoi rimuoverlo quando vuoi da Impostazioni ›
          Generali › VPN e gestione dispositivi. In alternativa, in Safari tocca Condividi ›
          “Aggiungi alla schermata Home”.
        </p>
      </section>
    </main>
  );
}
