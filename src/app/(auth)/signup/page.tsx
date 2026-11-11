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
  description: 'Crea il tuo account Solco e inizia il diario d’ascolto.',
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
            <p className={styles.kicker}>IL PRIMO ASCOLTO, PASSO PER PASSO</p>
            <h1 id="signup-title">Comincia da un album.</h1>
            <p className={styles.lead}>
              Crea il tuo account, cerca la musica che hai ascoltato e lascia una nota per
              ricordarla.
            </p>
            <ol className={styles.steps}>
              <li>
                <span>01</span>
                <p>Cerca un album o un artista.</p>
              </li>
              <li>
                <span>02</span>
                <p>Registra un ascolto e scegli il tuo voto.</p>
              </li>
              <li>
                <span>03</span>
                <p>Salva data, nota e contesto nel diario.</p>
              </li>
            </ol>
            <p className={styles.noPayment}>Un diario personale, riservato al tuo account.</p>
          </section>

          <Card className={styles.card}>
            <CardHeader className={styles.cardHeader}>
              <p className={styles.kicker}>CREA IL TUO ACCESSO</p>
              <CardTitle className={styles.cardTitle}>Benvenuto in Solco</CardTitle>
              <CardDescription className={styles.cardDescription}>
                Dopo la registrazione puoi salvare il tuo primo ascolto.
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
