// @polsia:user-owned — 6 specialist agents + 1 lead write a TikTok ad for Solco and return a
// machine-readable STORYBOARD (validated here), which tools/tiktok-ad/render.mjs turns into a
// 1080×1920 video from real screenshots of the site. Facts come from the repo and the live pages:
// the agents may not invent features, prices or claims.
import { readFile } from 'node:fs/promises';
import { passGate, SOLCO_ORIGIN, timedGet } from './lib.mjs';

/**
 * What a scene may show. The feature pages (/radio, /podcasts, …) ask a visitor without an account to
 * log in, so the ad uses what a visitor really sees: the home page's hero and its Free plan card, plus
 * kinetic text on the brand background, the opening logo and the end card.
 */
export const AD_SCREENS = ['logo', 'hero', 'free-plan', 'text', 'end-card'];
const SCREEN_HELP =
  'logo = marchio Solco su fondo scuro; hero = cima della home ("TUTTA LA MUSICA. UN SOLO PLAYER.", ' +
  'bottone "Inizia gratis"); free-plan = scheda del piano Free della home; text = solo testo grande ' +
  'animato sul colore del marchio; end-card = chiusura con logo, CTA e solcomusic.online';
const MOTIONS = ['zoom-in', 'zoom-out', 'pan-up', 'pan-down', 'static'];

export const AD_SYSTEM =
  'Sei in una squadra creativa che prepara una pubblicità TikTok (In-Feed Ad, verticale 9:16, ' +
  'pubblico italiano 18-34) per Solco, una web app musicale. Lavori SOLO con i fatti forniti: non ' +
  'inventare funzioni, prezzi, numeri, recensioni o testimonial. Niente musica protetta: l’audio va ' +
  'scelto dalla Commercial Music Library di TikTok. Scrivi in italiano, conciso, concreto.';

/** The 6 specialists. Each sees the same facts but answers one question. */
export const AD_SPECIALISTS = [
  {
    id: 'strategist',
    title: 'Strategia: pubblico, angolo, promessa e CTA',
    facts: (f) =>
      `${f.text}\n\nCompito: definisci pubblico, problema che Solco risolve, UNA promessa principale vera ` +
      `(dai fatti) e la call to action (l’azione è aprire solcomusic.online). Massimo 8 righe.`,
  },
  {
    id: 'hook',
    title: 'Copy: hook dei primi 2 secondi e testi a schermo',
    facts: (f) =>
      `${f.text}\n\nCompito: 5 hook alternativi (max 32 caratteri, devono fermare lo scroll nei primi 2 s) ` +
      `e le frasi a schermo per il resto dello spot (max 32 caratteri ciascuna). Indica il migliore e perché.`,
  },
  {
    id: 'director',
    title: 'Regia: storyboard scena per scena',
    facts: (f) =>
      `${f.text}\n\nCompito: storyboard di 15-20 s, scene da 1,5-3,5 s. Ogni scena usa UNO di questi ` +
      `schermi: ${SCREEN_HELP}. ` +
      `Movimento per scena: ${MOTIONS.join(', ')}. Indica per ogni scena: tempo, schermo, movimento, testo.`,
  },
  {
    id: 'sound',
    title: 'Suono: musica e ritmo dei tagli',
    facts: (f) =>
      `${f.text}\n\nCompito: direzione musicale (genere, mood, BPM) da cercare nella Commercial Music ` +
      `Library di TikTok (parole chiave di ricerca), dove tagliare sul beat, eventuali effetti. Nessun ` +
      `brano protetto o di artisti famosi nominati come colonna sonora.`,
  },
  {
    id: 'specs',
    title: 'Specifiche TikTok Ads e leggibilità',
    facts: (f) =>
      `${f.text}\n\nCompito: specifiche per un In-Feed Ad 1080×1920: durata consigliata, zone sicure ` +
      `(testo lontano da bordo alto, basso e destro dove ci sono interfaccia e bottoni), dimensione e ` +
      `contrasto dei testi, sottotitoli, cosa rende lo spot "nativo" e non da banner.`,
  },
  {
    id: 'compliance',
    title: 'Conformità: claim, regole TikTok e consumatore',
    facts: (f) =>
      `${f.text}\n\nCompito: controlla quali claim si possono usare e quali NO, secondo i fatti, le regole ` +
      `pubblicitarie di TikTok e il Codice del Consumo italiano (pratiche ingannevoli). In particolare ` +
      `"gratis", prezzi, Solco Pro, musica e marchi di terzi. Elenca: ammessi, vietati, formulazioni sicure.`,
  },
];

export const AD_LEAD_PROMPT =
  'Sei il direttore creativo. Unisci i contributi degli specialisti in UNO spot finale e rispondi ' +
  'SOLO con un blocco ```json``` valido con questa forma esatta:\n' +
  '{"title": string, "durationSeconds": number (15-20), "scenes": [{"start": number, "end": number, ' +
  `"screen": one of ${JSON.stringify(AD_SCREENS)}, "motion": one of ${JSON.stringify(MOTIONS)}, ` +
  '"headline": string (max 32 caratteri), "subline": string (max 48, anche "")}], "cta": string (max 24), ' +
  '"caption": string (testo dell’annuncio, max 100 caratteri: limite di TikTok Ads Manager), "hashtags": [string] (max 5), "music": {"mood": string, ' +
  '"bpm": number, "librarySearch": string}, "compliance": [string]}\n' +
  `Schermi: ${SCREEN_HELP}. ` +
  'La prima scena è l’hook (max 2,5 s), l’ultima è end-card con la CTA. Le scene sono contigue da 0 a ' +
  'durationSeconds. Usa solo claim ammessi dalla conformità. Niente testo fuori dal blocco JSON.';

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Validates and normalizes the lead's storyboard: allowed screens and motions only, contiguous
 * scenes from 0, 9-30 s in total, texts clipped to TikTok-readable lengths. Throws on anything that
 * cannot be rendered.
 */
export function parseStoryboard(text) {
  const raw = String(text ?? '');
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  let data;
  try {
    data = JSON.parse(block);
  } catch {
    throw new Error('storyboard: il capo squadra non ha restituito JSON valido');
  }
  const scenes = (Array.isArray(data.scenes) ? data.scenes : [])
    .map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      screen: AD_SCREENS.includes(s.screen) ? s.screen : null,
      motion: MOTIONS.includes(s.motion) ? s.motion : 'static',
      headline: clean(s.headline, 32),
      subline: clean(s.subline, 48),
    }))
    .filter((s) => s.screen && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (scenes.length < 3) throw new Error('storyboard: servono almeno 3 scene valide');
  // Contiguous from 0: each scene starts where the previous ended (durations are what the lead chose).
  let t = 0;
  for (const scene of scenes) {
    const length = Math.min(5, Math.max(1, scene.end - scene.start));
    scene.start = Number(t.toFixed(2));
    scene.end = Number((t + length).toFixed(2));
    t = scene.end;
  }
  if (t < 9 || t > 30) throw new Error(`storyboard: durata ${t}s fuori da 9-30 s`);
  if (scenes.at(-1).screen !== 'end-card') {
    scenes.push({ start: t, end: Number((t + 2.5).toFixed(2)), screen: 'end-card', motion: 'static', headline: clean(data.cta, 32), subline: 'solcomusic.online' });
    t = scenes.at(-1).end;
  }
  return {
    title: clean(data.title, 80) || 'Solco — TikTok ad',
    durationSeconds: Number(t.toFixed(2)),
    scenes,
    cta: clean(data.cta, 24) || 'Ascolta su Solco',
    caption: clean(data.caption, 100), // TikTok Ads Manager: ad text up to 100 characters
    hashtags: (Array.isArray(data.hashtags) ? data.hashtags : [])
      .map((h) => `#${String(h).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')}`)
      .filter((h) => h.length > 1)
      .slice(0, 5),
    music: {
      mood: clean(data.music?.mood, 80),
      bpm: Number.isFinite(Number(data.music?.bpm)) ? Math.round(Number(data.music.bpm)) : null,
      librarySearch: clean(data.music?.librarySearch, 80),
    },
    compliance: (Array.isArray(data.compliance) ? data.compliance : []).map((c) => clean(c, 200)).slice(0, 8),
  };
}

/** The facts the team works from: brand and features from the repo, headings of the live screens. */
export async function collectAdFacts({ root, fetchImpl = fetch } = {}) {
  const read = (path) => readFile(new URL(path, root), 'utf8').catch(() => '');
  const [brand, nav, billing] = await Promise.all([
    read('src/lib/brand.ts'),
    read('src/lib/nav.ts'),
    read('src/lib/business/solco-pro-billing.ts'),
  ]);
  const pick = (re) => brand.match(re)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const facts = {
    name: pick(/siteName\s*=\s*'([^']+)'/),
    description: pick(/siteDescription\s*=\s*'([^']+)'/) || pick(/siteDescription\s*=\s*\n\s*'([^']+)'/),
    tagline: pick(/tagline:\s*'([^']+)'/),
    sections: [...new Set(nav.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').match(/label: '([^']+)'/g) ?? [])]
      .map((l) => l.slice(8, -1))
      .filter((l) => !/^(Privacy|Termini|Contatti|Impostazioni|Stato|Messaggi)$/.test(l)),
    proOnSale: !/checkout resta bloccato|accesso pro resta bloccato/i.test(billing),
  };
  // The home page as a visitor without an account sees it: its visible text includes the plans and
  // their limits (the Free plan has a monthly cap), which the compliance agent needs.
  const gate = await passGate(SOLCO_ORIGIN, fetchImpl).catch(() => ({ cookie: null }));
  const home = await timedGet(new URL('/', SOLCO_ORIGIN).href, fetchImpl, 20_000, gate.cookie);
  const html = typeof home.body === 'string' ? home.body : '';
  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:li|p|h[1-6]|div|section|button|a)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&rsquo;/g, '’')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .filter((l) => !/iscritti a Solco|nuovi negli ultimi/i.test(l)) // a live counter, not a claim to reuse
    .join('\n')
    .slice(0, 3500);
  const screens = { home: { visibleText } };
  const text =
    `FATTI SU SOLCO (gli unici da usare):\n` +
    `- Nome: ${facts.name}. Sito: solcomusic.online (web app; c'è anche l'app da installare).\n` +
    `- Descrizione ufficiale: ${facts.description}\n` +
    `- Tagline: ${facts.tagline}\n` +
    `- Sezioni reali del sito: ${facts.sections.join(', ')}\n` +
    `- Solco Pro (24 € una tantum): ${facts.proOnSale ? 'in vendita' : 'NON acquistabile ora (checkout bloccato): NON pubblicizzarlo, niente prezzi'}\n` +
    `- Le pagine delle funzioni (radio, podcast, …) chiedono di accedere: nello spot si vede la home.\n` +
    `- Schermi per le scene: ${SCREEN_HELP}.\n` +
    `- Testo visibile della home (piani e limiti compresi, è la fonte dei claim):\n${visibleText}`;
  return { measuredAt: new Date().toISOString(), facts, screens, text };
}
