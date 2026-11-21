// @polsia:user-owned — 6 specialist agents + 1 lead write a TikTok ad for Solco and return a
// machine-readable STORYBOARD (validated here), which tools/tiktok-ad/render.mjs turns into a
// 1080×1920 video from real screenshots of the site. Facts come from the repo and the live pages:
// the agents may not invent features, prices or claims.
import { readFile } from 'node:fs/promises';
import { passGate, SOLCO_ORIGIN, timedGet } from './lib.mjs';

/** The only screens a scene may show: real Solco pages, plus the opening logo and the end card. */
export const AD_SCREENS = ['logo', '/', '/radio', '/podcasts', '/generi', '/classici', '/search', 'end-card'];
const PAGE_SCREENS = AD_SCREENS.filter((s) => s.startsWith('/'));
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
      `schermi: ${AD_SCREENS.join(', ')} (logo = apertura col marchio, end-card = chiusura con CTA). ` +
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
  '"caption": string (testo del post, max 150), "hashtags": [string] (max 5), "music": {"mood": string, ' +
  '"bpm": number, "librarySearch": string}, "compliance": [string]}\n' +
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
    caption: clean(data.caption, 150),
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
  const gate = await passGate(SOLCO_ORIGIN, fetchImpl).catch(() => ({ cookie: null }));
  const screens = {};
  for (const path of PAGE_SCREENS) {
    const r = await timedGet(new URL(path, SOLCO_ORIGIN).href, fetchImpl, 20_000, gate.cookie);
    const html = typeof r.body === 'string' ? r.body : '';
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? '';
    const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 8);
    screens[path] = { title, headings };
  }
  const text =
    `FATTI SU SOLCO (gli unici da usare):\n` +
    `- Nome: ${facts.name}. Sito: solcomusic.online (web app; c'è anche l'app da installare).\n` +
    `- Descrizione ufficiale: ${facts.description}\n` +
    `- Tagline: ${facts.tagline}\n` +
    `- Sezioni reali del sito: ${facts.sections.join(', ')}\n` +
    `- Solco Pro (24 € una tantum): ${facts.proOnSale ? 'in vendita' : 'NON acquistabile ora (checkout bloccato): NON pubblicizzarlo, niente prezzi'}\n` +
    `- Schermi disponibili per le scene (titolo e intestazioni reali):\n` +
    Object.entries(screens)
      .map(([path, s]) => `  ${path}: ${s.title}${s.headings.length ? ` — ${s.headings.join(' · ')}` : ''}`)
      .join('\n');
  return { measuredAt: new Date().toISOString(), facts, screens, text };
}
