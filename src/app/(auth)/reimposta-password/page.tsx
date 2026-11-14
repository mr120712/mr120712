// @polsia:user-owned — /reimposta-password: arrivo dal link dell'email (?token=…), nuova password.
import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/components/custom/reset-password-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import styles from '../signup/auth.module.css';

export const metadata: Metadata = {
  title: 'Nuova password',
  description: 'Scegli una nuova password per il tuo account Solco.',
  robots: { index: false, follow: false },
  // Il token è nell'URL: nessun Referer verso altri siti.
  referrer: 'no-referrer',
};

export default function ResetPasswordPage() {
  return (
    <main className={styles.page}>
      <div className={styles.grid}>
        <section className={styles.story} aria-labelledby="reset-title">
          <p className={styles.kicker}>RECUPERO PASSWORD</p>
          <h1 id="reset-title">Scegli una nuova password.</h1>
          <p className={styles.lead}>
            Usa almeno 8 caratteri. Dopo il cambio chiudiamo le sessioni aperte su tutti i
            dispositivi.
          </p>
        </section>

        <Card className={styles.card}>
          <CardHeader className={styles.cardHeader}>
            <p className={styles.kicker}>NUOVA PASSWORD</p>
            <CardTitle className={styles.cardTitle}>Reimposta la password</CardTitle>
            <CardDescription className={styles.cardDescription}>
              Inserisci la nuova password due volte.
            </CardDescription>
          </CardHeader>
          <CardContent className={styles.cardContent}>
            <ResetPasswordForm />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
