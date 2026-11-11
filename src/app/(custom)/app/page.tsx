// @polsia:user-owned — download dell'app Android (APK) di Solco.
import { Download, Smartphone } from 'lucide-react';
import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import styles from './app.module.css';

export const metadata: Metadata = {
  title: 'App Android',
  description: 'Scarica l’app Solco per Android.',
  alternates: { canonical: '/app' },
};

const steps = [
  'Tocca “Scarica l’APK” dal telefono Android.',
  'Apri il file scaricato. Se Android lo chiede, consenti al browser di installare app sconosciute.',
  'Tocca “Installa” e apri Solco dalla schermata Home.',
];

export default function AndroidAppPage() {
  return (
    <main className={styles.page}>
      <div className={styles.icon} aria-hidden="true">
        <Smartphone />
      </div>
      <h1>Solco per Android</h1>
      <p className={styles.lead}>
        L’app apre Solco a schermo intero, con il player, la Libreria e i tuoi piani. Si aggiorna da
        sola insieme al sito.
      </p>
      <Button asChild size="lg">
        <a href="/solco.apk" download="solco.apk">
          <Download aria-hidden="true" />
          Scarica l’APK
        </a>
      </Button>
      <p className={styles.meta}>Versione 1.1.0 · Android 7.0 o successivo</p>
      <ol className={styles.steps}>
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className={styles.meta}>
        Hai già installato una versione precedente di Solco? Disinstallala prima: la nuova app è
        firmata con una chiave diversa e Android non può aggiornarla.
      </p>
    </main>
  );
}
