// @polsia:user-owned — route error boundary (Client Component). Restyle or delete.

'use client';

import { Button } from '@/components/ui/button';

export default function RouteError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="container mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="font-display text-3xl font-semibold tracking-tight">
        Qualcosa è andato storto
      </h1>
      <p className="text-muted-foreground">Si è verificato un errore imprevisto. Riprova.</p>
      <Button onClick={() => reset()}>Riprova</Button>
    </main>
  );
}
