import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'ARTEX Gateway',
  description: 'Auth gateway for the ARTEX console.',
  robots: 'noindex,nofollow',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
