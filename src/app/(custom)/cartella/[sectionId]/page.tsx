// @polsia:user-owned — pagina «Mostra tutti» di una sezione dei "brani in evidenza"
// (/cartella/<id>): SOLO i brani della cartella con i diritti dichiarati. Guscio HTML: i dati
// arrivano dal client (FeaturedSectionView via apiFetch), dietro il login come il resto dell'app
// (RequireLogin: /cartella/ non è fra le rotte pubbliche). Metadati generici: nessuna lettura qui.
// Il percorso è /cartella/ e non /evidenza/…: /evidenza/ è il prefisso PUBBLICO dei link diretti
// dei singoli brani (vedi featured-sections.ts).
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FeaturedSectionView } from '@/components/custom/music/featured-section-view';
import { isFeaturedSectionId } from '@/lib/music/featured-sections';

export const metadata: Metadata = {
  title: 'Brani in evidenza',
  description: 'Tutti i brani in evidenza di una sezione di Solco, da ascoltare nel player.',
  robots: { index: false, follow: false },
};

export default async function FeaturedSectionPage({
  params,
}: {
  params: Promise<{ sectionId: string }>;
}) {
  const { sectionId } = await params;
  if (!isFeaturedSectionId(sectionId)) notFound();
  return <FeaturedSectionView sectionId={sectionId} />;
}
