// @polsia:user-owned — Home di Solco in stile app di streaming (schede, caroselli, player).

import {
  Crown,
  Disc3,
  Download,
  Gift,
  Globe2,
  GraduationCap,
  Library,
  Mic,
  Radio,
  Search,
  Smartphone,
  TrendingUp,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { InstallAppBanner } from '@/components/custom/install-app-banner';
import { AiSearchShortcut } from '@/components/custom/music/ai-search-shortcut';
import { AudiusSection } from '@/components/custom/music/audius-section';
import { JamendoSection } from '@/components/custom/music/jamendo-section';
import { LocalMusicHomeCard } from '@/components/custom/music/local-music-home-card';
import { FeedSectionLink, MoodChipGroup, MoodChips } from '@/components/custom/music/mood-chips';
import { HomeMoodSwitch } from '@/components/custom/music/mood-feed';
import { PodcastHomeRow } from '@/components/custom/music/podcast-home-row';
import { PublicUploadsHomeSection } from '@/components/custom/music/public-uploads-home-section';
import { RadioHomeRow } from '@/components/custom/music/radio-home-row';
import { RecentlyPlayedRow } from '@/components/custom/music/recently-played-row';
import { TikTokClips } from '@/components/custom/music/tiktok-clips';
import { YouTubeCharts } from '@/components/custom/music/youtube-charts';
import { AppTopBar } from '@/components/custom/site-nav';
import { TelegramButton } from '@/components/custom/telegram-button';
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
  { href: '#la-tua-musica', label: 'Musica offline', icon: Download },
  { href: '/pubblica', label: 'Pubblica', icon: Globe2 },
  { href: '/piani', label: 'Premium', icon: Crown },
  { href: '/premi#invita', label: 'Invita amici', icon: Gift },
  { href: '/flashcards', label: 'Flashcard', icon: GraduationCap },
  { href: '/app', label: 'Installa l’app', icon: Smartphone },
];

export default function HomePage() {
  // Everything under the intro as always ("Tutto"). A mood chip (?mood=…) shows that mood's feed
  // in its place, right under the chips.
  const defaultFeed = (
    <>
      <InstallAppBanner />

      <RecentlyPlayedRow />

      {/* "La tua musica" offline, versione compatta: ascolto rapido; gestione completa in Libreria. */}
      <LocalMusicHomeCard />

      {/* Anteprima della libreria pubblica dei brani caricati dagli utenti. */}
      <PublicUploadsHomeSection />

      <div className={styles.feed}>
        <YouTubeCharts />
        <AudiusSection />
        <TikTokClips />
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
        <TelegramButton variant="card" />
      </div>
    </>
  );

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
          {/* Until the URL is read the chips show "Tutto" and do nothing. */}
          <Suspense fallback={<MoodChipGroup selectedId={null} />}>
            <MoodChips />
          </Suspense>
          <nav className={styles.shortcuts} aria-label="Scorciatoie">
            <AiSearchShortcut />
            {shortcuts.map((item) => {
              const content = (
                <>
                  <item.icon aria-hidden="true" />
                  {item.label}
                </>
              );
              // A section of the "Tutto" feed (#tendenze): with a mood on, it goes back first.
              return item.href.startsWith('#') ? (
                <Suspense key={item.href} fallback={<Link href={item.href}>{content}</Link>}>
                  <FeedSectionLink targetId={item.href.slice(1)}>{content}</FeedSectionLink>
                </Suspense>
              ) : (
                <Link key={item.href} href={item.href}>
                  {content}
                </Link>
              );
            })}
          </nav>
        </section>

        <Suspense fallback={defaultFeed}>
          <HomeMoodSwitch className={styles.feed}>{defaultFeed}</HomeMoodSwitch>
        </Suspense>

        <footer className={styles.footer}>
          <p>Solco · Ogni ascolto lascia un solco.</p>
          <nav aria-label="Navigazione a piè di pagina">
            <Link href="/app">Installa l’app</Link>
            <Link href="/community">Community</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Termini</Link>
            <TelegramButton variant="link" className={styles.footerTelegram} />
          </nav>
        </footer>
      </main>
    </>
  );
}
