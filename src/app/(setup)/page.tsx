// @polsia:user-owned — Home di Solco in stile app di streaming (schede, caroselli, player).

import {
  Crown,
  Disc3,
  Gift,
  Library,
  Mic,
  Radio,
  Search,
  Smartphone,
  TrendingUp,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { InstallAppBanner } from '@/components/custom/install-app-banner';
import { AiSearchShortcut } from '@/components/custom/music/ai-search-shortcut';
import { AudiusSection } from '@/components/custom/music/audius-section';
import { JamendoSection } from '@/components/custom/music/jamendo-section';
import { PodcastHomeRow } from '@/components/custom/music/podcast-home-row';
import { RadioHomeRow } from '@/components/custom/music/radio-home-row';
import { RecentlyPlayedRow } from '@/components/custom/music/recently-played-row';
import { YouTubeCharts } from '@/components/custom/music/youtube-charts';
import { AppTopBar } from '@/components/custom/site-nav';
import { genreCatalog } from '@/lib/music/genre-catalog';
import styles from './home.module.css';

export const metadata: Metadata = {
  title: { absolute: 'Scopri musica su Solco' },
  description:
    'Classifiche musicali, brani e video da YouTube, radio dal vivo da tutto il mondo e podcast in un unico player.',
  alternates: { canonical: '/' },
};

const shortcuts = [
  { href: '#tendenze', label: 'Classifiche', icon: TrendingUp },
  { href: '/generi', label: 'Generi', icon: Disc3 },
  { href: '/radio', label: 'Radio', icon: Radio },
  { href: '/podcasts', label: 'Podcast', icon: Mic },
  { href: '/library', label: 'Libreria', icon: Library },
  { href: '/piani', label: 'Premium', icon: Crown },
  { href: '/premi#invita', label: 'Invita amici', icon: Gift },
  { href: '/app', label: 'Installa l’app', icon: Smartphone },
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
            <AiSearchShortcut />
            {shortcuts.map((item) => (
              <Link key={item.href} href={item.href}>
                <item.icon aria-hidden="true" />
                {item.label}
              </Link>
            ))}
          </nav>
        </section>

        <InstallAppBanner />

        <RecentlyPlayedRow />

        <div className={styles.feed}>
          <YouTubeCharts />
          <AudiusSection />
          <JamendoSection />
          <RadioHomeRow />
          <PodcastHomeRow />
          <section className={styles.genres} aria-labelledby="genres-heading">
            <h2 id="genres-heading">Generi e playlist</h2>
            <nav aria-label="Generi">
              {genreCatalog
                .filter((entry) => entry.family === 'playlist')
                .map((entry) => (
                  <Link key={entry.slug} href={`/generi/${entry.slug}`}>
                    {entry.name}
                  </Link>
                ))}
              <Link href="/generi">Tutti i generi →</Link>
            </nav>
          </section>
        </div>

        <footer className={styles.footer}>
          <p>Solco · Ogni ascolto lascia un solco.</p>
          <nav aria-label="Navigazione a piè di pagina">
            <Link href="/app">Installa l’app</Link>
            <Link href="/community">Community</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Termini</Link>
          </nav>
        </footer>
      </main>
    </>
  );
}
