// @polsia:user-owned — «Crea playlist»: il modo più facile di creare una playlist (descrizione,
// brano o artista di partenza, atmosfera), con una bozza da sistemare prima di salvarla. Come la
// Libreria, richiede l'accesso (RequireLogin protegge ogni pagina non pubblica).
import type { Metadata } from 'next';
import { PlaylistEngine } from '@/components/custom/music/playlist-engine';

export const metadata: Metadata = {
  title: 'Crea playlist',
  description:
    'Crea una playlist in pochi tocchi: descrivila, parti da un brano o scegli l’atmosfera, poi sistemala e salvala nella Libreria.',
  robots: { index: false },
};

export default function CreaPlaylistPage() {
  return <PlaylistEngine />;
}
