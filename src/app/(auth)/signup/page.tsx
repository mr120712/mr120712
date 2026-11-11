// @polsia:user-owned — seeded by polsia/modules/better-auth; restyle freely.

import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthPageGate } from '@/components/custom/auth-page-gate';
import { SignUpForm } from '@/components/custom/sign-up-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { isSafeAuthDestination } from '@/lib/business/auth-form';
import styles from './auth.module.css';

export const metadata: Metadata = {
  title: 'Registrati',
  description:
    'Crea il tuo account Solco gratuito: musica, radio dal vivo e podcast in un unico player.',
};

function authDestination(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isSafeAuthDestination(candidate) ? candidate : null;
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackURL?: string | string[] }>;
}) {
  const params = await searchParams;
  const callbackURL = authDestination(params.callbackURL);
  const loginHref = callbackURL
    ? `/login?callbackURL=${encodeURIComponent(callbackURL)}`
    : '/login';

  return (
    <AuthPageGate>
      <main className={styles.page}>
        <div className={styles.grid}>
          <section className={styles.story} aria-labelledby="signup-title">
            <p className={styles.kicker}>GRATIS, IN UN MINUTO</p>
            <h1 id="signup-title">Tutta la tua musica, in un solo posto.</h1>
            <p className={styles.lead}>
              Crea il tuo account gratuito e ascolta brani, radio dal vivo e podcast da tutto il
              mondo.
            </p>
            <ol className={styles.steps}>
              <li>
                <span>01</span>
                <p>Cerca brani, artisti, radio e podcast.</p>
              </li>
              <li>
                <span>02</span>
                <p>Salva i preferiti e crea le tue playlist.</p>
              </li>
              <li>
                <span>03</span>
                <p>Invita gli amici e ottieni Premium gratis.</p>
              </li>
            </ol>
            <p className={styles.noPayment}>
              Nessun pagamento richiesto: 40 ascolti al mese e radio gratis.
            </p>
          </section>

          <Card className={styles.card}>
            <CardHeader className={styles.cardHeader}>
              <p className={styles.kicker}>CREA IL TUO ACCESSO</p>
              <CardTitle className={styles.cardTitle}>Benvenuto in Solco</CardTitle>
              <CardDescription className={styles.cardDescription}>
                Dopo la registrazione puoi iniziare subito ad ascoltare.
              </CardDescription>
            </CardHeader>
            <CardContent className={styles.cardContent}>
              <SignUpForm />
              <p className={styles.switchLink}>
                Hai già un account? <Link href={loginHref}>Accedi</Link>
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </AuthPageGate>
  );
}
