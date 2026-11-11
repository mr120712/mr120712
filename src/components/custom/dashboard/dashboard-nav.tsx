// @polsia:user-owned
'use client';

import { AudioLines, ListMusic, Search, UserRound, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const navItems = [
  {
    href: '/search',
    label: 'Cerca musica',
    icon: Search,
  },
  {
    href: '/dashboard',
    label: 'Preferiti e playlist',
    icon: ListMusic,
  },
  {
    href: '/dashboard/crea-musica',
    label: 'Crea un brano',
    icon: AudioLines,
  },
  {
    href: '/community',
    label: 'Community',
    icon: UsersRound,
  },
  {
    href: '/profile',
    label: 'Profilo',
    icon: UserRound,
  },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Dashboard" className="flex flex-wrap gap-2 pb-1 lg:grid lg:pb-0">
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href;

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
              active
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
