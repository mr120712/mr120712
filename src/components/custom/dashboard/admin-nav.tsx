// @polsia:user-owned
'use client';

import { Activity, AudioLines, Bot, Clapperboard, LayoutDashboard } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

// Add every admin feature here; child pages inherit this navigation.
const navItems = [
  { href: '/admin', label: 'Panoramica', icon: LayoutDashboard },
  { href: '/admin/assistente', label: 'Assistente IA', icon: Bot },
  { href: '/admin/music-rights', label: 'Diritti musicali', icon: AudioLines },
  { href: '/admin/tiktok', label: 'Video TikTok', icon: Clapperboard },
  { href: '/admin/monitoraggio', label: 'Monitoraggio', icon: Activity },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Amministrazione" className="flex flex-wrap gap-2 pb-1 lg:grid lg:pb-0">
      {navItems.map((item) => {
        const Icon = item.icon;
        const active =
          pathname === item.href ||
          (item.href !== '/admin' && pathname.startsWith(`${item.href}/`));

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
