// @polsia:user-owned — root error boundary; REPLACES the layout, so it renders its own
// <html>/<body> with inline styles (theme/providers unavailable). Restyle or delete.

'use client';

import './globals.css';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-8 py-8 text-center font-body text-foreground">
        <h1 className="font-display text-2xl font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground">A critical error occurred. Please try again.</p>
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md border border-border bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
