// @polsia:user-owned — pagine con la libreria pubblica SPENTA (src/lib/features.ts): la Home non
// mostra la sezione «Brani più ascoltati dalla community» né la scorciatoia /pubblica, /scarica non
// rimanda a /pubblica e mostra il pannello «I tuoi brani caricati» (i propri brani restano
// scaricabili e rimovibili) e la privacy avvisa che la libreria non è attiva, senza togliere il
// testo. Con l'interruttore acceso tutto torna com'era.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ featureOn: false }));

vi.mock('@/lib/features', () => ({ publicUploadsEnabled: () => state.featureOn }));

// La Home compone molte righe client che leggono dati: qui interessa solo il suo markup.
vi.mock('@/components/custom/site-nav', () => ({ AppTopBar: () => null }));
vi.mock('@/components/custom/install-app-banner', () => ({ InstallAppBanner: () => null }));
vi.mock('@/components/custom/music/ai-search-shortcut', () => ({ AiSearchShortcut: () => null }));
vi.mock('@/components/custom/music/audius-section', () => ({ AudiusSection: () => null }));
vi.mock('@/components/custom/music/jamendo-section', () => ({ JamendoSection: () => null }));
vi.mock('@/components/custom/music/home-tracks-section', () => ({ HomeTracksSection: () => null }));
vi.mock('@/components/custom/music/live-music-search', () => ({ LiveMusicSearch: () => null }));
vi.mock('@/components/custom/music/local-music-home-card', () => ({
  LocalMusicHomeCard: () => null,
}));
vi.mock('@/components/custom/music/public-uploads-home-section', () => ({
  PublicUploadsHomeSection: () => <section data-testid="public-uploads-home">Community</section>,
}));
vi.mock('@/components/custom/music/podcast-home-row', () => ({ PodcastHomeRow: () => null }));
vi.mock('@/components/custom/music/radio-home-row', () => ({ RadioHomeRow: () => null }));
vi.mock('@/components/custom/music/recently-played-row', () => ({
  RecentlyPlayedRow: () => null,
}));
vi.mock('@/components/custom/music/tiktok-clips', () => ({ TikTokClips: () => null }));
vi.mock('@/components/custom/music/youtube-charts', () => ({ YouTubeCharts: () => null }));
vi.mock('@/components/custom/telegram-button', () => ({ TelegramButton: () => null }));
vi.mock('@/components/custom/music/download-by-url', () => ({ DownloadByUrl: () => null }));
vi.mock('@/components/custom/music/my-uploads-panel', () => ({
  MyUploadsPanel: () => <section data-testid="my-uploads-panel">I tuoi brani caricati</section>,
}));

import PrivacyPage from '@/app/(custom)/privacy/page';
import ScaricaDaUrlPage from '@/app/(custom)/scarica/page';
import HomePage from '@/app/(setup)/page';

function render(element: React.ReactElement): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(element);
  return root;
}

const text = (root: HTMLElement) => (root.textContent ?? '').replace(/\s+/g, ' ');

beforeEach(() => {
  state.featureOn = false;
});

describe('Home', () => {
  it('libreria spenta: niente sezione della community né scorciatoia /pubblica', () => {
    const root = render(<HomePage />);
    expect(root.querySelector('[data-testid="public-uploads-home"]')).toBeNull();
    expect(root.querySelector('a[href="/pubblica"]')).toBeNull();
    // Le altre scorciatoie restano.
    const shortcuts = root.querySelector('nav[aria-label="Scorciatoie"]');
    expect(shortcuts?.querySelector('a[href="/library"]')).not.toBeNull();
    expect(shortcuts?.querySelector('a[href="/piani"]')).not.toBeNull();
  });

  it('libreria accesa: la sezione e la scorciatoia tornano', () => {
    state.featureOn = true;
    const root = render(<HomePage />);
    expect(root.querySelector('[data-testid="public-uploads-home"]')).not.toBeNull();
    const link = root.querySelector('nav[aria-label="Scorciatoie"] a[href="/pubblica"]');
    expect(link?.textContent).toContain('Pubblica');
  });
});

describe('/scarica', () => {
  it('libreria spenta: i tuoi brani restano scaricabili, senza link a /pubblica', () => {
    const root = render(<ScaricaDaUrlPage />);
    expect(root.querySelector('a[href="/pubblica"]')).toBeNull();
    expect(text(root)).toContain(
      'I tuoi brani caricati su Solco: il link è il tuo, verificato per proprietario.',
    );
    // Senza /pubblica, i propri brani si scaricano e si rimuovono da qui.
    expect(root.querySelector('[data-testid="my-uploads-panel"]')).not.toBeNull();
  });

  it('libreria accesa: il link a Pubblica torna', () => {
    state.featureOn = true;
    const root = render(<ScaricaDaUrlPage />);
    expect(root.querySelector('a[href="/pubblica"]')?.textContent).toBe('Pubblica');
    expect(text(root)).toContain(
      'I tuoi brani caricati su Solco (Pubblica): il link è il tuo, verificato per proprietario.',
    );
    // Con la libreria accesa la gestione dei propri brani sta su /pubblica.
    expect(root.querySelector('[data-testid="my-uploads-panel"]')).toBeNull();
  });
});

describe('/privacy', () => {
  const NOTE =
    'Al momento la libreria pubblica dei brani caricati e questa classifica non sono attive';

  it('libreria spenta: il testo sulla classifica resta, con la nota che non è attiva', () => {
    const content = text(render(<PrivacyPage />));
    expect(content).toContain('classifica «Brani più ascoltati dalla community»');
    expect(content).toContain(NOTE);
  });

  it('libreria accesa: niente nota', () => {
    state.featureOn = true;
    const content = text(render(<PrivacyPage />));
    expect(content).toContain('classifica «Brani più ascoltati dalla community»');
    expect(content).not.toContain(NOTE);
  });
});
