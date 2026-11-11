// @polsia:user-owned — home page di Solco.

import { ArrowRight, AudioLines, Search } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthNav } from '@/components/custom/auth-nav';
import { HomeMobileNav } from '@/components/custom/home-mobile-nav';
import { MotionKitProvider } from '@/components/custom/motion-kit/motion-kit-provider';
import { Reveal } from '@/components/custom/motion-kit/reveal';
import { HomeCatalog } from '@/components/custom/music/home-catalog';
import { Button } from '@/components/ui/button';
import { siteName } from '@/lib/brand';
import styles from './home.module.css';

export const metadata: Metadata = {
  title: { absolute: 'Scopri musica su Solco' },
  description:
    'Scopri tendenze, brani, playlist e artisti Audius; cerca anche video musicali su YouTube nel player ufficiale.',
  alternates: { canonical: '/' },
};

export default function HomePage() {
  return (
    <MotionKitProvider>
      <main className={styles.site}>
        <header className={styles.header}>
          <Link className={styles.brand} href="/" aria-label={`${siteName}, inizio pagina`}>
            <span className={styles.brandMark} aria-hidden="true">
              s
            </span>
            <span>solco</span>
          </Link>
          <nav className={styles.nav} aria-label="Navigazione home">
            <Link href="#tendenze">Tendenze</Link>
            <Link href="#nuove-uscite">Nuove uscite</Link>
            <Link href="#generi">Generi</Link>
          </nav>
          <Button asChild className={styles.headerAction} size="sm">
            <Link href="/search">
              <Search aria-hidden="true" />
              Cerca
            </Link>
          </Button>
          <AuthNav className={styles.authActions} />
          <HomeMobileNav className={styles.mobileNav} />
        </header>

        <section className={styles.hero} id="scopri" aria-labelledby="hero-title">
          <Reveal as="div" trigger="load" className={styles.heroCopy}>
            <p className={styles.eyebrow}>SCOPERTA MUSICALE · AUDIUS + YOUTUBE</p>
            <h1 id="hero-title">
              <span>Il prossimo</span>
              <em>ascolto lascia un solco.</em>
            </h1>
            <p className={styles.heroLead}>
              Esplora le tendenze Audius e cerca brani, artisti o video musicali. Ogni fonte resta
              identificata e i video si aprono nel player ufficiale YouTube.
            </p>
            <form className={styles.searchForm} action="/search" method="get">
              <label className={styles.searchField} htmlFor="home-music-query">
                <Search aria-hidden="true" />
                <span className="sr-only">
                  Cerca un brano, un artista, una playlist o un video musicale
                </span>
                <input
                  id="home-music-query"
                  name="q"
                  type="search"
                  maxLength={80}
                  placeholder="Brano, artista o video"
                  autoComplete="off"
                />
              </label>
              <Button type="submit" className={styles.searchSubmit}>
                Cerca musica <ArrowRight aria-hidden="true" />
              </Button>
            </form>
            <p className={styles.searchHint}>
              Audius è la scheda Solco; puoi scegliere se inviare la stessa query anche a YouTube.
            </p>
          </Reveal>

          <aside className={styles.heroAside} aria-label="Come funziona la scoperta su Solco">
            <div className={styles.asideTopline}>
              <span>CATALOGO APERTO</span>
              <AudioLines aria-hidden="true" />
            </div>
            <p className={styles.asideNumber}>01</p>
            <p className={styles.asideTitle}>La fonte resta vicina.</p>
            <p className={styles.asideCopy}>
              Apri i brani autorizzati con Solco e i video soltanto nel player YouTube.
            </p>
            <Link href="/search" className={styles.asideLink}>
              Vai alla ricerca <ArrowRight aria-hidden="true" />
            </Link>
          </aside>
        </section>

        <HomeCatalog />

        <footer className={styles.footer}>
          <Link className={styles.footerBrand} href="/">
            Solco
          </Link>
          <p>Ogni ascolto lascia un solco.</p>
          <nav aria-label="Navigazione a piè di pagina">
            <Link href="/search">Cerca</Link>
            <Link href="/community">Community</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Termini</Link>
          </nav>
        </footer>
      </main>
    </MotionKitProvider>
  );
}
