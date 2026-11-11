// @polsia:user-owned — barra delle schede in basso (mobile) per Home, Cerca, Radio, Podcast e Libreria.
'use client';

import { Home, Library, Mic, Radio, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { hidesTabBar, type TabIcon, tabItems } from '@/lib/nav';
import styles from './app-tab-bar.module.css';

const icons: Record<TabIcon, typeof Home> = {
  home: Home,
  search: Search,
  radio: Radio,
  podcast: Mic,
  library: Library,
};

export function isTabActive(href: string, pathname: string) {
  if (href === '/') return pathname === '/';
  if (href === '/podcasts') return pathname === '/podcasts' || pathname.startsWith('/podcasts/');
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppTabBar() {
  const pathname = usePathname();
  const hidden = hidesTabBar(pathname);

  useEffect(() => {
    document.body.classList.toggle('has-tab-bar', !hidden);
    return () => document.body.classList.remove('has-tab-bar');
  }, [hidden]);

  if (hidden) return null;

  return (
    <nav className={styles.tabBar} aria-label="Schede principali">
      {tabItems.map((item) => {
        const Icon = icons[item.icon];
        const active = isTabActive(item.href, pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={styles.tab}
            aria-current={active ? 'page' : undefined}
          >
            <Icon aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
