// @polsia:user-owned

import type { ReactNode } from 'react';
import { AdminShell } from '@/components/custom/dashboard/admin-shell';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
