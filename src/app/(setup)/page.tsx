// @polsia:user-owned — Home di Solco in stile app di streaming (schede, caroselli, player).

import { Crown, Library, Mic, Radio, Search, TrendingUp } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { HomeCatalog } from '@/components/custom/music/home-catalog';
import { JamendoSection } from '@/components/custom/music/jamendo-section';
import { PodcastHomeRow } from '@/components/custom/music/podcast-home-row';
import { RadioHomeRow } from '@/components/custom/music/radio-home-row';
import { RecentlyPlayedRow } from '@/components/custom/music/recently-played-row';
import { AppTopBar } from '@/components/custom/site-nav';
import styles from './home.module.css';

export const metadata: Metadata = {
  title: { absolute: 'Scopri musica su Solco' },
  description:
    'Classifiche, nuove uscite e artisti Audius, radio dal vivo da tutto il mondo, podcast e video musicali YouTube nel player ufficiale.',
  alternates: { canonical: '/' },
};

const shortcuts = [
  { href: '#tendenze', label: 'Classifiche', icon: TrendingUp },
  { href: '/radio', label: 'Radio', icon: Radio },
  { href: '/podcasts', label: 'Podcast', icon: Mic },
  { href: '/library', label: 'Libreria', icon: Library },
  { href: '/piani', label: 'Premium', icon: Crown },
];

export default function HomePage() {
  return (
    <>
      <AppTopBar />
      <main className={styles.home}>
        <section className={styles.intro} aria-labelledby="home-title">
          <h1 id="home-title">Cosa ascoltiamo oggi?</h1>
          <form className={styles.searchForm} action="/search" method="get">
            <label className={styles.searchField} htmlFor="home-music-query">
              <Search aria-hidden="true" />
              <span className="sr-only">
                Cerca un brano, un artista, una playlist, una radio o un podcast
              </span>
              <input
                id="home-music-query"
                name="q"
                type="search"
                maxLength={80}
                placeholder="Brani, artisti, radio, podcast"
                autoComplete="off"
              />
            </label>
          </form>
          <nav className={styles.shortcuts} aria-label="Scorciatoie">
            {shortcuts.map((item) => (
              <Link key={item.href} href={item.href}>
                <item.icon aria-hidden="true" />
                {item.label}
              </Link>
            ))}
          </nav>
        </section>

        <RecentlyPlayedRow />

        <HomeCatalog
          afterCharts={
            <>
              <JamendoSection />
              <RadioHomeRow />
              <PodcastHomeRow />
            </>
          }
        />

        <footer className={styles.footer}>
          <p>Solco · Ogni ascolto lascia un solco.</p>
          <nav aria-label="Navigazione a piè di pagina">
            <Link href="/community">Community</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Termini</Link>
          </nav>
        </footer>
      </main>
    </>
  );
}
