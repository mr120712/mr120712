// @polsia:user-owned — metadata delle pagine pubbliche in sitemap che non hanno un test proprio
// (/bot, /impostazioni, /terms): canonical esplicito (www, https, un solo indirizzo per pagina),
// titolo pulito per Google (il marchio non si ripete) e nessun noindex, perché sono inviate con la
// sitemap.
import { describe, expect, it } from 'vitest';
import { metadata as botMetadata } from '@/app/(custom)/bot/page';
import { metadata as settingsMetadata } from '@/app/(custom)/impostazioni/page';
import { metadata as termsMetadata } from '@/app/(custom)/terms/page';

describe('pagine pubbliche in sitemap: metadata per Google', () => {
  it('/bot: titolo assoluto «Bot Solco», descrizione e canonical, nessun noindex', () => {
    expect(botMetadata.title).toEqual({ absolute: 'Bot Solco' });
    expect((botMetadata.description ?? '').length).toBeGreaterThan(40);
    expect(botMetadata.alternates?.canonical).toBe('/bot');
    expect(botMetadata.robots).toBeUndefined();
  });

  it('/impostazioni: canonical e nessun noindex (è nella sitemap)', () => {
    expect(settingsMetadata.title).toBe('Impostazioni');
    expect(settingsMetadata.alternates?.canonical).toBe('/impostazioni');
    expect(settingsMetadata.robots).toBeUndefined();
  });

  it('/terms: titolo assoluto «Termini di Solco» e canonical', () => {
    expect(termsMetadata.title).toEqual({ absolute: 'Termini di Solco' });
    expect(termsMetadata.alternates?.canonical).toBe('/terms');
    expect(termsMetadata.robots).toBeUndefined();
  });
});
