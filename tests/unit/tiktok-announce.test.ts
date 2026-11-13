// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sanitizeAnnouncement } from '@/lib/business/tiktok-announce';

type Beat = { at: string; onScreen: string; voiceover: string; visual: string };
type Plan = {
  hook: string;
  caption: string;
  hashtags: string[];
  script: { durationSeconds: number; beats: Beat[]; cta: string };
  soundIdea: string;
  altText: string;
};

const beat = (over: Partial<Beat> = {}): Beat => ({
  at: '0-3s',
  onScreen: 'testo',
  voiceover: 'voce',
  visual: 'video',
  ...over,
});

const plan = (over: Partial<Plan> = {}): Plan => ({
  hook: 'Gancio',
  caption: 'Didascalia',
  hashtags: ['#solco', 'musica'],
  script: { durationSeconds: 30, beats: [beat()], cta: 'Prova Solco' },
  soundIdea: 'Un trend lo-fi calmo',
  altText: 'Video di esempio',
  ...over,
});

describe('sanitizeAnnouncement', () => {
  it('pulisce e deduplica gli hashtag (un solo #, minuscolo, max 8)', () => {
    const out = sanitizeAnnouncement(
      plan({ hashtags: ['#Techno', 'techno', 'Lo-Fi 🎧', '', '   ', '###Rave'] }),
    );
    expect(out.hashtags).toEqual(['#techno', '#lofi', '#rave']);
  });

  it('non supera 8 hashtag', () => {
    const many = Array.from({ length: 12 }, (_, i) => `tag${i}`);
    expect(sanitizeAnnouncement(plan({ hashtags: many })).hashtags).toHaveLength(8);
  });

  it('limita la durata a 10-60s e arrotonda, con fallback su valori non validi', () => {
    expect(
      sanitizeAnnouncement(plan({ script: { durationSeconds: 120, beats: [beat()], cta: 'x' } }))
        .script.durationSeconds,
    ).toBe(60);
    expect(
      sanitizeAnnouncement(plan({ script: { durationSeconds: 2, beats: [beat()], cta: 'x' } }))
        .script.durationSeconds,
    ).toBe(10);
    expect(
      sanitizeAnnouncement(plan({ script: { durationSeconds: 33.7, beats: [beat()], cta: 'x' } }))
        .script.durationSeconds,
    ).toBe(34);
    expect(
      sanitizeAnnouncement(
        plan({ script: { durationSeconds: Number.NaN, beats: [beat()], cta: 'x' } }),
      ).script.durationSeconds,
    ).toBe(30);
  });

  it('scarta le scene vuote prima di applicare il limite di 8', () => {
    // La scena vuota è in mezzo alle prime 8: il filtro DEVE elaborarla e scartarla.
    const beats = [beat(), beat({ onScreen: '', voiceover: '', visual: '' }), beat()];
    const out = sanitizeAnnouncement(plan({ script: { durationSeconds: 20, beats, cta: 'x' } }));
    expect(out.script.beats).toHaveLength(2);
    expect(out.script.beats.every((b) => b.onScreen || b.voiceover || b.visual)).toBe(true);
  });

  it('taglia a 8 scene quando ce ne sono di più', () => {
    const beats = Array.from({ length: 10 }, () => beat());
    const out = sanitizeAnnouncement(plan({ script: { durationSeconds: 20, beats, cta: 'x' } }));
    expect(out.script.beats).toHaveLength(8);
  });

  it('accorcia i testi troppo lunghi (didascalia a 200, come il campo del clip)', () => {
    const out = sanitizeAnnouncement(plan({ hook: 'a'.repeat(500), caption: 'b'.repeat(500) }));
    expect(out.hook.length).toBe(140);
    expect(out.caption.length).toBe(200);
  });
});
