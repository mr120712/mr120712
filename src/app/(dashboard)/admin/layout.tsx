// @polsia:user-owned

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AdminShell } from '@/components/custom/dashboard/admin-shell';

/**
 * Anche per l'amministratore che la riceve, la pagina non è mai indicizzabile né conservata in
 * copia. Chi non è amministratore non arriva nemmeno qui: il proxy risponde 404
 * (src/lib/security/admin-gate.ts).
 */
export const metadata: Metadata = {
  title: 'Amministrazione',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
