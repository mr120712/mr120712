// @polsia:user-owned — preferiti e playlist ora vivono nella scheda Libreria.
import { redirect } from 'next/navigation';

export default function DashboardPage() {
  redirect('/library');
}
