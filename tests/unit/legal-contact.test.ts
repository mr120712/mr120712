// @polsia:user-owned — identità e contatti del gestore (legal-contact.ts): frase sul titolare con
// e senza denominazione pubblicata, link mailto con oggetto, e la configurazione reale di brand.ts
// (email presente, Paese, tempo di risposta) usata da /contatti, privacy, termini e security.txt.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { legalContact } from '@/lib/brand';
import {
  CONTACT_SUBJECTS,
  contactMailto,
  hasPublishedOwner,
  type LegalContact,
  ownerStatement,
} from '@/lib/legal-contact';

const BASE: LegalContact = {
  ownerName: '',
  address: '',
  taxId: '',
  country: 'Italia',
  email: 'ciao@example.test',
  responseTime: 'entro 2 giorni',
};

describe('ownerStatement', () => {
  it('senza denominazione pubblicata dice che il servizio è indipendente e dove chiedere i dati', () => {
    expect(hasPublishedOwner(BASE)).toBe(false);
    const text = ownerStatement(BASE);
    expect(text).toContain('servizio indipendente');
    expect(text).toContain('Italia');
    expect(text).toContain('ciao@example.test');
    expect(text).not.toMatch(/bozza|confermat|proprietario deve/i);
  });

  it('con la denominazione la riporta, con indirizzo e codice fiscale solo se presenti', () => {
    expect(ownerStatement({ ...BASE, ownerName: ' Solco di Mario Rossi ' })).toBe(
      'Il titolare del servizio è Solco di Mario Rossi (Italia).',
    );
    expect(
      ownerStatement({
        ...BASE,
        ownerName: 'Solco S.r.l.',
        address: 'Via Roma 1, 00100 Roma',
        taxId: 'IT01234567890',
      }),
    ).toBe(
      'Il titolare del servizio è Solco S.r.l., Via Roma 1, 00100 Roma, codice fiscale o partita IVA IT01234567890 (Italia).',
    );
    expect(hasPublishedOwner({ ownerName: 'X' })).toBe(true);
    expect(hasPublishedOwner({ ownerName: '   ' })).toBe(false);
  });
});

describe('contactMailto', () => {
  it('senza oggetto è il solo mailto; con oggetto lo codifica per ogni motivo di contatto', () => {
    expect(contactMailto(BASE)).toBe('mailto:ciao@example.test');
    for (const [key, subject] of Object.entries(CONTACT_SUBJECTS)) {
      const link = contactMailto(BASE, key as keyof typeof CONTACT_SUBJECTS);
      expect(link.startsWith('mailto:ciao@example.test?subject=')).toBe(true);
      expect(decodeURIComponent(link.split('subject=')[1] ?? '')).toBe(subject);
    }
  });
});

describe('legalContact (brand.ts)', () => {
  it('ha email, Paese e tempo di risposta; le voci vuote restano stringhe', () => {
    expect(legalContact.email).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/i);
    expect(legalContact.country.length).toBeGreaterThan(0);
    expect(legalContact.responseTime.length).toBeGreaterThan(0);
    for (const key of ['ownerName', 'address', 'taxId'] as const) {
      expect(typeof legalContact[key]).toBe('string');
    }
  });

  it('security.txt punta alla stessa casella e alla pagina Contatti, con una scadenza futura', () => {
    const text = readFileSync('public/.well-known/security.txt', 'utf8');
    expect(text).toContain(`Contact: mailto:${legalContact.email}`);
    expect(text).toContain('Contact: https://www.solcomusic.online/contatti');
    expect(text).toContain('Canonical: https://www.solcomusic.online/.well-known/security.txt');
    const expires = /^Expires: (.+)$/m.exec(text)?.[1] ?? '';
    expect(new Date(expires).getTime()).toBeGreaterThan(Date.now());
  });
});
