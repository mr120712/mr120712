// @polsia:user-owned — /password-dimenticata: richiesta del link per reimpostare la password.
import type { Metadata } from 'next';
import Link from 'next/link';
import { ForgotPasswordForm } from '@/components/custom/forgot-password-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import styles from '../signup/auth.module.css';

export const metadata: Metadata = {
  title: 'Password dimenticata',
  description: 'Ricevi via email il link per scegliere una nuova password del tuo account Solco.',
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main className={styles.page}>
      <div className={styles.grid}>
        <section className={styles.story} aria-labelledby="forgot-title">
          <p className={styles.kicker}>RECUPERO PASSWORD</p>
          <h1 id="forgot-title">Nessun problema, succede.</h1>
          <p className={styles.lead}>
            Inserisci l’email del tuo account: ti mandiamo un link per scegliere una nuova password.
          </p>
        </section>

        <Card className={styles.card}>
          <CardHeader className={styles.cardHeader}>
            <p className={styles.kicker}>PASSWORD DIMENTICATA</p>
            <CardTitle className={styles.cardTitle}>Reimposta la password</CardTitle>
            <CardDescription className={styles.cardDescription}>
              Il link vale un’ora e si può usare una sola volta.
            </CardDescription>
          </CardHeader>
          <CardContent className={styles.cardContent}>
            <ForgotPasswordForm />
            <p className={styles.switchLink}>
              Ti sei ricordato la password? <Link href="/login">Accedi</Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
