// @polsia:user-owned — brano di audio.com → elemento del player di Solco, SOLO per le licenze che
// permettono di riprodurlo in Solco (CC0, CC BY, CC BY-SA, CC BY-ND, con stream https su
// audio.com) e mai per le cover: in ogni altro caso restituisce null e il brano si ascolta solo nel
// player ufficiale di audio.com (AudioComEmbedDialog).
//
// Lo stream segue la via dei file pubblici con stream diretto (playbackMode 'upload' + streamUrl
// https, come i brani pubblici e i brani in evidenza pubblici): il browser scarica l'audio
// direttamente da audio.com. L'id però è proprio, `audiocom:<id>` (audioComQualifiedId), e il
// player lo tratta come le fonti contate: prima di far partire l'audio chiede il permesso a
// /api/music/plays, quindi serve un account (gli ospiti vedono l'invito ad accedere) e l'ascolto
// conta nei 40 ascolti Free del mese come Audius e podcast (Premium illimitato; riascoltare lo
// stesso brano entro 30 minuti non conta). Siccome nessuna route di stream di Solco vede
// quell'audio, è il permesso stesso a registrare l'ascolto (vedi permitRecordsPlay in
// play-quota.ts). Come i file pubblici: niente cronologia (non porta lo streamUrl), niente
// precaricamento sul secondo deck, niente pannello «Testo».
// L'attribuzione richiesta dalle licenze CC compare anche nel player: autore (artistName),
// «audio.com · <licenza>» nella riga della fonte e il link «Il brano su audio.com» alla pagina.
import type { MusicPlayerTrack } from '@/components/custom/music/music-player';
import type { AudioComTrack } from '@/lib/contracts/audiocom';
import {
  audioComLicenseName,
  audioComQualifiedId,
  isAudioComPlayable,
} from '@/lib/music/audiocom-license';

export const AUDIOCOM_SOURCE_NAME = 'audio.com';

export function audioComToPlayerTrack(track: AudioComTrack): MusicPlayerTrack | null {
  if (!isAudioComPlayable(track) || !track.streamUrl) return null;
  return {
    qualifiedId: audioComQualifiedId(track.id),
    title: track.title,
    artistName: track.authorName,
    artworkUrl: track.imageUrl,
    sourceLabel: `${AUDIOCOM_SOURCE_NAME} · ${audioComLicenseName(track.license)}`,
    sourceUrl: track.pageUrl,
    sourceUrlLabel: 'Il brano su audio.com',
    durationSeconds: track.durationSeconds,
    streamUrl: track.streamUrl,
    playbackMode: 'upload',
  };
}
