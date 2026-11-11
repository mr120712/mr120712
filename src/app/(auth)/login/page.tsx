// @polsia:user-owned — seeded by polsia/modules/better-auth; restyle freely.

import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthPageGate } from '@/components/custom/auth-page-gate';
import { SignInForm } from '@/components/custom/sign-in-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { isSafeAuthDestination } from '@/lib/business/auth-form';
import styles from '../signup/auth.module.css';

export const metadata: Metadata = {
  title: 'Accedi',
  description: 'Accedi al tuo diario personale di Solco.',
};

function authDestination(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isSafeAuthDestination(candidate) ? candidate : null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackURL?: string | string[] }>;
}) {
  const params = await searchParams;
  const callbackURL = authDestination(params.callbackURL);
  const signupHref = callbackURL
    ? `/signup?callbackURL=${encodeURIComponent(callbackURL)}`
    : '/signup';

  return (
    <AuthPageGate>
      <main className={styles.page}>
        <div className={styles.grid}>
          <section className={styles.story} aria-labelledby="login-title">
            <p className={styles.kicker}>IL TUO DIARIO D’ASCOLTO</p>
            <h1 id="login-title">Ritrova le note che hai lasciato.</h1>
            <p className={styles.lead}>
              Ogni album, data e contesto che hai salvato resta legato al tuo account.
            </p>
          </section>

          <Card className={styles.card}>
            <CardHeader className={styles.cardHeader}>
              <p className={styles.kicker}>ACCESSO</p>
              <CardTitle className={styles.cardTitle}>Accedi a Solco</CardTitle>
              <CardDescription className={styles.cardDescription}>
                I tuoi ascolti e le tue note sono visibili soltanto dal tuo account.
              </CardDescription>
            </CardHeader>
            <CardContent className={styles.cardContent}>
              <SignInForm />
              <p className={styles.switchLink}>
                Non hai ancora un account? <Link href={signupHref}>Registrati</Link>
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </AuthPageGate>
  );
}
