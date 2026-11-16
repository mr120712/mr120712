// @polsia:user-owned — chi gestisce Solco e come si contatta: una sola fonte (brand.ts →
// legalContact) letta dalla pagina /contatti, dall'informativa privacy, dai termini, dai dati
// strutturati (Organization) e da security.txt. Funzioni pure, senza React: testabili e usabili sia
// dal server sia dal client. Le voci vuote non si pubblicano: la pagina dice onestamente cosa c'è.

/** Dati del titolare del servizio, come li pubblica il sito. Le voci vuote restano private. */
export type LegalContact = {
  /** Denominazione del titolare (persona o società); '' finché non si pubblica. */
  ownerName: string;
  /** Indirizzo postale del titolare; '' finché non si pubblica. */
  address: string;
  /** Partita IVA o codice fiscale, se il servizio è un'attività; '' altrimenti. */
  taxId: string;
  /** Paese del gestore, sempre pubblicato. */
  country: string;
  /** Casella per assistenza, privacy, pagamenti e segnalazioni. */
  email: string;
  /** Tempo di risposta indicativo, in italiano (es. «di norma entro 2 giorni lavorativi»). */
  responseTime: string;
};

/** Oggetti pronti per le email: una riga per ogni motivo di contatto. */
export const CONTACT_SUBJECTS = {
  support: 'Assistenza Solco',
  privacy: 'Privacy e dati personali',
  billing: 'Pagamenti e abbonamento',
  content: 'Segnalazione di un contenuto',
  security: 'Sicurezza: segnalazione di una vulnerabilità',
} as const;

export type ContactSubject = keyof typeof CONTACT_SUBJECTS;

/** Link mailto verso la casella di contatto, con l'oggetto già compilato. */
export function contactMailto(
  contact: Pick<LegalContact, 'email'>,
  subject?: ContactSubject,
): string {
  const base = `mailto:${contact.email}`;
  return subject ? `${base}?subject=${encodeURIComponent(CONTACT_SUBJECTS[subject])}` : base;
}

/** True quando il titolare ha pubblicato la propria denominazione. */
export function hasPublishedOwner(contact: Pick<LegalContact, 'ownerName'>): boolean {
  return contact.ownerName.trim().length > 0;
}

/**
 * La frase sul titolare per le pagine legali: con la denominazione pubblicata la riporta per
 * intero (indirizzo e codice fiscale solo se presenti); altrimenti dice che il servizio è gestito
 * in forma indipendente e che i dati completi si ottengono scrivendo alla casella di contatto.
 */
export function ownerStatement(contact: LegalContact): string {
  if (hasPublishedOwner(contact)) {
    const parts = [contact.ownerName.trim()];
    if (contact.address.trim()) parts.push(contact.address.trim());
    if (contact.taxId.trim()) parts.push(`codice fiscale o partita IVA ${contact.taxId.trim()}`);
    return `Il titolare del servizio è ${parts.join(', ')} (${contact.country}).`;
  }
  return (
    `Solco è un servizio indipendente, gestito dal suo creatore in ${contact.country}, senza una ` +
    `società alle spalle. La denominazione e l'indirizzo completi del titolare si ottengono ` +
    `scrivendo a ${contact.email}.`
  );
}
