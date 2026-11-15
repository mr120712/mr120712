// @polsia:user-owned — brano di audio.com → elemento del player di Solco, SOLO per le licenze che
// permettono di riprodurlo in Solco (CC0, CC BY, CC BY-SA, CC BY-ND, con stream https su
// audio.com) e mai per le cover: in ogni altro caso restituisce null e il brano si ascolta solo nel
// player ufficiale di audio.com (AudioComEmbedDialog).
//
// Nessuna modifica al player: si riusa la via generica dei file pubblici con stream diretto
// (playbackMode 'upload' + streamUrl https, come i brani pubblici e i brani in evidenza pubblici).
// L'id `upload:audiocom~<id>` segue le regole di quella via: nessun permesso /api/music/plays,
// quindi NESSUN controllo dell'accesso (i brani CC di audio.com suonano anche per chi non ha fatto
// l'accesso, come i brani pubblici) e nessun conteggio del piano Free (lo stream va dal browser ad
// audio.com, nessuna route di Solco lo vede), niente cronologia, niente pannello «Testo». Per
// chiedere l'accesso (ed eventualmente il limite Free) serve un prefisso proprio (es.
// `audiocom:<id>`) gestito dal player e da isValidPlayId: è lavoro del player, non di questo file.
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
