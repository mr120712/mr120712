// @polsia:user-owned — testi della landing pubblica in più lingue (menu "Lingua" in alto).
// Solo la landing: il resto dell'app resta in italiano. La lingua si sceglie dal menu (ricordata
// su questo dispositivo), oppure con ?lang=xx nel link, altrimenti quella del browser se è tra
// quelle disponibili; l'italiano è la lingua di partenza. Modulo puro: niente I/O, testabile.

export const LANDING_LOCALES = [
  { code: 'it', label: 'Italiano' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
] as const;

export type LandingLocale = (typeof LANDING_LOCALES)[number]['code'];
export const DEFAULT_LANDING_LOCALE: LandingLocale = 'it';
/** Chiave di localStorage della lingua scelta (per dispositivo). */
export const LANDING_LOCALE_STORAGE_KEY = 'solco:lang';

/** Piani mostrati sulla landing (gli id di solco-pro-pricing). */
export type LandingPlanId = 'free' | 'premium' | 'premium-plus' | 'family';

export type LandingMessages = {
  languageLabel: string;
  login: string;
  kicker: string;
  titleLine1: string;
  titleLine2: string;
  lead: string;
  ctaStart: string;
  ctaLogin: string;
  marquee: string[];
  legal: { before: string; terms: string; middle: string; privacy: string; after: string };
  plansEyebrow: string;
  plansTitle: string;
  plansLead: string;
  free: string;
  perMonth: string;
  perYear: (price: string) => string;
  recommended: string;
  planCtaFree: string;
  planCtaPaid: string;
  note: { before: string; strong: string; after: string };
  /** Avviso che l'app (dopo l'accesso) è in italiano; vuoto per l'italiano. */
  appLanguageNote: string;
  plans: Record<LandingPlanId, { tagline: string; perks: string[] }>;
};

const it: LandingMessages = {
  languageLabel: 'Lingua',
  login: 'Accedi',
  kicker: 'Musica · Radio dal vivo · Podcast',
  titleLine1: 'Tutta la musica.',
  titleLine2: 'Un solo player.',
  lead: 'Brani, radio dal vivo e podcast in un unico posto. Gratis. Accedi e parti.',
  ctaStart: 'Inizia gratis',
  ctaLogin: 'Accedi',
  marquee: [
    'Musica',
    'Radio dal vivo',
    'Podcast',
    'Classifiche',
    'In background',
    'Offline',
    'Gratis',
  ],
  legal: {
    before: 'Accedendo accetti i ',
    terms: 'Termini',
    middle: ' e la ',
    privacy: 'Privacy',
    after: '.',
  },
  plansEyebrow: 'PIANI',
  plansTitle: 'Scegli il tuo piano',
  plansLead: 'Inizia gratis, passa a Premium quando vuoi. Prezzi in euro, al mese.',
  free: 'Gratis',
  perMonth: '/mese',
  perYear: (price) => `o ${price}/anno`,
  recommended: 'Consigliato',
  planCtaFree: 'Inizia gratis',
  planCtaPaid: 'Accedi e abbonati',
  note: {
    before: 'Al primo abbonamento hai ',
    strong: '10 giorni di Premium gratis',
    after: '. Puoi disdire quando vuoi.',
  },
  appLanguageNote: '',
  plans: {
    free: {
      tagline: 'Per iniziare',
      perks: ['40 ascolti al mese', 'Radio e YouTube senza limiti', 'Libreria e playlist'],
    },
    premium: {
      tagline: 'Il più scelto',
      perks: ['Ascolti illimitati', 'Cerca con l’AI', 'Ascolto in background illimitato'],
    },
    'premium-plus': {
      tagline: 'Per chi vuole di più',
      perks: ['Tutto Premium', 'Statistiche avanzate e temi extra', 'Creazione di brani'],
    },
    family: {
      tagline: 'Per tutta la famiglia',
      perks: ['Tutti i vantaggi Premium', 'Fino a 6 account', 'Un unico abbonamento'],
    },
  },
};

const en: LandingMessages = {
  languageLabel: 'Language',
  login: 'Log in',
  kicker: 'Music · Live radio · Podcasts',
  titleLine1: 'All the music.',
  titleLine2: 'One player.',
  lead: 'Songs, live radio and podcasts in one place. Free. Log in and press play.',
  ctaStart: 'Start for free',
  ctaLogin: 'Log in',
  marquee: ['Music', 'Live radio', 'Podcasts', 'Charts', 'In the background', 'Offline', 'Free'],
  legal: {
    before: 'By logging in you accept the ',
    terms: 'Terms',
    middle: ' and the ',
    privacy: 'Privacy Policy',
    after: '.',
  },
  plansEyebrow: 'PLANS',
  plansTitle: 'Choose your plan',
  plansLead: 'Start for free and upgrade to Premium whenever you like. Prices in euros, per month.',
  free: 'Free',
  perMonth: '/month',
  perYear: (price) => `or ${price}/year`,
  recommended: 'Recommended',
  planCtaFree: 'Start for free',
  planCtaPaid: 'Log in and subscribe',
  note: {
    before: 'Your first subscription comes with ',
    strong: '10 days of Premium for free',
    after: '. Cancel anytime.',
  },
  appLanguageNote: 'The app itself is in Italian for now.',
  plans: {
    free: {
      tagline: 'To get started',
      perks: ['40 plays a month', 'Unlimited radio and YouTube', 'Library and playlists'],
    },
    premium: {
      tagline: 'Most popular',
      perks: ['Unlimited plays', 'Search with AI', 'Unlimited background listening'],
    },
    'premium-plus': {
      tagline: 'For those who want more',
      perks: ['Everything in Premium', 'Advanced stats and extra themes', 'Song creation'],
    },
    family: {
      tagline: 'For the whole family',
      perks: ['All Premium benefits', 'Up to 6 accounts', 'One single subscription'],
    },
  },
};

const es: LandingMessages = {
  languageLabel: 'Idioma',
  login: 'Iniciar sesión',
  kicker: 'Música · Radio en directo · Pódcasts',
  titleLine1: 'Toda la música.',
  titleLine2: 'Un solo reproductor.',
  lead: 'Canciones, radio en directo y pódcasts en un solo lugar. Gratis. Inicia sesión y dale al play.',
  ctaStart: 'Empieza gratis',
  ctaLogin: 'Iniciar sesión',
  marquee: [
    'Música',
    'Radio en directo',
    'Pódcasts',
    'Listas de éxitos',
    'En segundo plano',
    'Sin conexión',
    'Gratis',
  ],
  legal: {
    before: 'Al iniciar sesión aceptas los ',
    terms: 'Términos',
    middle: ' y la ',
    privacy: 'Privacidad',
    after: '.',
  },
  plansEyebrow: 'PLANES',
  plansTitle: 'Elige tu plan',
  plansLead: 'Empieza gratis y pásate a Premium cuando quieras. Precios en euros, al mes.',
  free: 'Gratis',
  perMonth: '/mes',
  perYear: (price) => `o ${price}/año`,
  recommended: 'Recomendado',
  planCtaFree: 'Empieza gratis',
  planCtaPaid: 'Inicia sesión y suscríbete',
  note: {
    before: 'Con tu primera suscripción tienes ',
    strong: '10 días de Premium gratis',
    after: '. Puedes cancelar cuando quieras.',
  },
  appLanguageNote: 'Por ahora, la app está en italiano.',
  plans: {
    free: {
      tagline: 'Para empezar',
      perks: ['40 reproducciones al mes', 'Radio y YouTube sin límites', 'Biblioteca y playlists'],
    },
    premium: {
      tagline: 'El más elegido',
      perks: ['Reproducciones ilimitadas', 'Busca con IA', 'Escucha en segundo plano ilimitada'],
    },
    'premium-plus': {
      tagline: 'Para quien quiere más',
      perks: ['Todo Premium', 'Estadísticas avanzadas y temas extra', 'Creación de canciones'],
    },
    family: {
      tagline: 'Para toda la familia',
      perks: ['Todas las ventajas Premium', 'Hasta 6 cuentas', 'Una sola suscripción'],
    },
  },
};

const fr: LandingMessages = {
  languageLabel: 'Langue',
  login: 'Se connecter',
  kicker: 'Musique · Radio en direct · Podcasts',
  titleLine1: 'Toute la musique.',
  titleLine2: 'Un seul lecteur.',
  lead: 'Titres, radio en direct et podcasts au même endroit. Gratuit. Connectez-vous et c’est parti.',
  ctaStart: 'Commencer gratuitement',
  ctaLogin: 'Se connecter',
  marquee: [
    'Musique',
    'Radio en direct',
    'Podcasts',
    'Classements',
    'En arrière-plan',
    'Hors ligne',
    'Gratuit',
  ],
  legal: {
    before: 'En vous connectant, vous acceptez les ',
    terms: 'Conditions d’utilisation',
    middle: ' et la ',
    privacy: 'Politique de confidentialité',
    after: '.',
  },
  plansEyebrow: 'FORMULES',
  plansTitle: 'Choisissez votre formule',
  plansLead: 'Commencez gratuitement, passez à Premium quand vous voulez. Prix en euros, par mois.',
  free: 'Gratuit',
  perMonth: '/mois',
  perYear: (price) => `ou ${price}/an`,
  recommended: 'Recommandé',
  planCtaFree: 'Commencer gratuitement',
  planCtaPaid: 'Se connecter et s’abonner',
  note: {
    before: 'Avec votre premier abonnement, vous avez ',
    strong: '10 jours de Premium offerts',
    after: '. Résiliable à tout moment.',
  },
  appLanguageNote: 'Pour l’instant, l’application est en italien.',
  plans: {
    free: {
      tagline: 'Pour commencer',
      perks: ['40 écoutes par mois', 'Radio et YouTube sans limite', 'Bibliothèque et playlists'],
    },
    premium: {
      tagline: 'Le plus choisi',
      perks: ['Écoutes illimitées', 'Recherche avec l’IA', 'Écoute en arrière-plan illimitée'],
    },
    'premium-plus': {
      tagline: 'Pour aller plus loin',
      perks: ['Tout Premium', 'Statistiques avancées et thèmes en plus', 'Création de titres'],
    },
    family: {
      tagline: 'Pour toute la famille',
      perks: ['Tous les avantages Premium', 'Jusqu’à 6 comptes', 'Un seul abonnement'],
    },
  },
};

const de: LandingMessages = {
  languageLabel: 'Sprache',
  login: 'Anmelden',
  kicker: 'Musik · Live-Radio · Podcasts',
  titleLine1: 'Die ganze Musik.',
  titleLine2: 'Ein einziger Player.',
  lead: 'Songs, Live-Radio und Podcasts an einem Ort. Kostenlos. Anmelden und loslegen.',
  ctaStart: 'Kostenlos starten',
  ctaLogin: 'Anmelden',
  marquee: ['Musik', 'Live-Radio', 'Podcasts', 'Charts', 'Im Hintergrund', 'Offline', 'Kostenlos'],
  legal: {
    before: 'Mit der Anmeldung akzeptierst du die ',
    terms: 'Nutzungsbedingungen',
    middle: ' und die ',
    privacy: 'Datenschutzerklärung',
    after: '.',
  },
  plansEyebrow: 'TARIFE',
  plansTitle: 'Wähle deinen Tarif',
  plansLead: 'Starte kostenlos und wechsle zu Premium, wann du willst. Preise in Euro, pro Monat.',
  free: 'Kostenlos',
  perMonth: '/Monat',
  perYear: (price) => `oder ${price}/Jahr`,
  recommended: 'Empfohlen',
  planCtaFree: 'Kostenlos starten',
  planCtaPaid: 'Anmelden und abonnieren',
  note: {
    before: 'Beim ersten Abo bekommst du ',
    strong: '10 Tage Premium gratis',
    after: '. Jederzeit kündbar.',
  },
  appLanguageNote: 'Die App selbst ist vorerst auf Italienisch.',
  plans: {
    free: {
      tagline: 'Zum Einstieg',
      perks: [
        '40 Wiedergaben pro Monat',
        'Radio und YouTube ohne Limit',
        'Bibliothek und Playlists',
      ],
    },
    premium: {
      tagline: 'Am beliebtesten',
      perks: ['Unbegrenzte Wiedergaben', 'Suche mit KI', 'Unbegrenztes Hören im Hintergrund'],
    },
    'premium-plus': {
      tagline: 'Für alle, die mehr wollen',
      perks: ['Alles aus Premium', 'Erweiterte Statistiken und Extra-Designs', 'Songs erstellen'],
    },
    family: {
      tagline: 'Für die ganze Familie',
      perks: ['Alle Premium-Vorteile', 'Bis zu 6 Konten', 'Ein einziges Abo'],
    },
  },
};

const pt: LandingMessages = {
  languageLabel: 'Idioma',
  login: 'Entrar',
  kicker: 'Música · Rádio ao vivo · Podcasts',
  titleLine1: 'Toda a música.',
  titleLine2: 'Um só player.',
  lead: 'Músicas, rádio ao vivo e podcasts em um só lugar. Grátis. Entre e comece a ouvir.',
  ctaStart: 'Comece grátis',
  ctaLogin: 'Entrar',
  marquee: [
    'Música',
    'Rádio ao vivo',
    'Podcasts',
    'Paradas',
    'Em segundo plano',
    'Offline',
    'Grátis',
  ],
  legal: {
    before: 'Ao entrar, você aceita os ',
    terms: 'Termos de uso',
    middle: ' e a ',
    privacy: 'Política de privacidade',
    after: '.',
  },
  plansEyebrow: 'PLANOS',
  plansTitle: 'Escolha o seu plano',
  plansLead: 'Comece grátis e mude para o Premium quando quiser. Preços em euros, por mês.',
  free: 'Grátis',
  perMonth: '/mês',
  perYear: (price) => `ou ${price}/ano`,
  recommended: 'Recomendado',
  planCtaFree: 'Comece grátis',
  planCtaPaid: 'Entre e assine',
  note: {
    before: 'Na primeira assinatura você ganha ',
    strong: '10 dias de Premium grátis',
    after: '. Cancele quando quiser.',
  },
  appLanguageNote: 'Por enquanto, o app está em italiano.',
  plans: {
    free: {
      tagline: 'Para começar',
      perks: ['40 reproduções por mês', 'Rádio e YouTube sem limites', 'Biblioteca e playlists'],
    },
    premium: {
      tagline: 'O mais escolhido',
      perks: ['Reproduções ilimitadas', 'Pesquise com IA', 'Ouça em segundo plano sem limites'],
    },
    'premium-plus': {
      tagline: 'Para quem quer mais',
      perks: ['Tudo do Premium', 'Estatísticas avançadas e temas extras', 'Criação de músicas'],
    },
    family: {
      tagline: 'Para toda a família',
      perks: ['Todas as vantagens do Premium', 'Até 6 contas', 'Uma única assinatura'],
    },
  },
};

export const LANDING_MESSAGES: Record<LandingLocale, LandingMessages> = { it, en, es, fr, de, pt };

/** true se `value` è un codice lingua disponibile sulla landing. */
export function isLandingLocale(value: unknown): value is LandingLocale {
  return typeof value === 'string' && LANDING_LOCALES.some((locale) => locale.code === value);
}

/** La lingua da un tag BCP 47 ("pt-BR" → "pt"), se disponibile. */
export function landingLocaleFromTag(tag: string | null | undefined): LandingLocale | null {
  const primary = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return isLandingLocale(primary) ? primary : null;
}

/**
 * Lingua della landing: ?lang= nel link, poi la scelta salvata su questo dispositivo, poi la prima
 * lingua del browser disponibile, infine l'italiano.
 */
export function resolveLandingLocale(input: {
  param?: string | null;
  stored?: string | null;
  browser?: readonly string[];
}): LandingLocale {
  return (
    landingLocaleFromTag(input.param) ??
    (isLandingLocale(input.stored) ? input.stored : null) ??
    (input.browser ?? []).map(landingLocaleFromTag).find((code) => code !== null) ??
    DEFAULT_LANDING_LOCALE
  );
}

/** Prezzo in euro nel formato della lingua (es. "4,99 €", "€4.99"); 0 = "Gratis"/"Free"… */
export function formatLandingPrice(cents: number, locale: LandingLocale): string {
  if (cents === 0) return LANDING_MESSAGES[locale].free;
  const region: Record<LandingLocale, string> = {
    it: 'it-IT',
    en: 'en-IE',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    pt: 'pt-BR',
  };
  return new Intl.NumberFormat(region[locale], { style: 'currency', currency: 'EUR' }).format(
    cents / 100,
  );
}
