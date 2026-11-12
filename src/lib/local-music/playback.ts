// @polsia:user-owned — object URL per riprodurre i brani della libreria sul dispositivo.
//
// Il player suona un brano locale impostando come src un object URL del Blob salvato in
// IndexedDB: nessuna rete, il file non lascia il dispositivo. Ogni URL va revocato quando il
// brano cambia (o il player si smonta), non subito dopo play(): alcuni motori rileggono il Blob
// durante i salti. revoke() è idempotente.
//
// È il punto d'ingresso del player (in ogni pagina): dipende solo da reader.ts, mai da store.ts
// e dai lettori di tag, che restano nel bundle della sezione "La tua musica".

import type { UrlApi } from '@/lib/local-music/media';
import { getLocalMusicReader, type LocalMusicReader } from '@/lib/local-music/reader';

export { getTrack, setTrackDuration } from '@/lib/local-music/reader';

export type ObjectUrlHandle = { url: string; revoke: () => void };

export type ObjectUrlOptions = {
  store?: Pick<LocalMusicReader, 'getTrackBlob' | 'getArtworkBlob'>;
  urlApi?: UrlApi;
};

/** Object URL di un Blob con un revoke() da chiamare una volta sola (le successive non fanno nulla). */
export function objectUrlHandle(blob: Blob, urlApi: UrlApi = URL): ObjectUrlHandle {
  const url = urlApi.createObjectURL(blob);
  let revoked = false;
  return {
    url,
    revoke: () => {
      if (revoked) return;
      revoked = true;
      try {
        urlApi.revokeObjectURL(url);
      } catch {
        // Già revocato o documento in chiusura.
      }
    },
  };
}

/** Object URL dell'audio di un brano locale, o null se il brano non c'è più. */
export async function createObjectUrlForTrack(
  id: string,
  options: ObjectUrlOptions = {},
): Promise<ObjectUrlHandle | null> {
  const blob = await (options.store ?? getLocalMusicReader()).getTrackBlob(id);
  return blob ? objectUrlHandle(blob, options.urlApi) : null;
}

/** Object URL della copertina di un brano locale (lista, player, Media Session), o null. */
export async function createObjectUrlForArtwork(
  id: string,
  options: ObjectUrlOptions = {},
): Promise<ObjectUrlHandle | null> {
  const blob = await (options.store ?? getLocalMusicReader()).getArtworkBlob(id);
  return blob ? objectUrlHandle(blob, options.urlApi) : null;
}
