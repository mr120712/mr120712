// @polsia:user-owned — elenco delle sezioni della guida per chi inizia (/guida): un solo posto per
// id e titoli, usato sia dall'indice sia dai titoli delle sezioni, così non possono divergere.

export const GUIDE_SECTIONS = [
  { id: 'primi-passi', title: 'Primi passi in 5 minuti' },
  { id: 'account', title: 'Account e accesso' },
  { id: 'cercare', title: 'Cercare e ascoltare' },
  { id: 'lettore', title: 'Il lettore musicale' },
  { id: 'schermo-bloccato', title: 'Ascoltare col telefono bloccato' },
  { id: 'libreria', title: 'La tua Libreria e le playlist' },
  { id: 'radio-podcast', title: 'Radio e podcast' },
  { id: 'app', title: 'Solco sul telefono (app)' },
  { id: 'piani', title: 'Piani: Free e Premium' },
  { id: 'altro', title: 'Altre cose che puoi fare' },
  { id: 'problemi', title: 'Problemi comuni' },
  { id: 'parole', title: 'Parole utili' },
  { id: 'aiuto', title: 'Serve altro aiuto?' },
] as const;

export type GuideSectionId = (typeof GUIDE_SECTIONS)[number]['id'];

/** Id dell'indice (destinazione dei link «Torna all’indice»). */
export const GUIDE_TOC_ID = 'indice';

export function guideSectionTitle(id: GuideSectionId): string {
  const section = GUIDE_SECTIONS.find((entry) => entry.id === id);
  if (!section) throw new Error(`Sezione della guida sconosciuta: ${id}`);
  return section.title;
}
