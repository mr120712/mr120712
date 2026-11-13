// @polsia:user-owned — logica server dei "brani in evidenza" della Home. Elenca i file audio che
// l'amministratore ha caricato DIRETTAMENTE nel bucket AWS S3 (dalla console AWS) e li espone come
// brani riproducibili in Home. Sono distinti dagli upload degli utenti (/pubblica): si escludono
// gli oggetti sotto il prefisso `public-uploads/`. Lo stream usa un URL GET firmato (presigned),
// così i file in evidenza possono anche restare PRIVATI sul bucket (nessun accesso pubblico
// richiesto) e il browser li scarica direttamente da S3 (seek/Range nativi, niente proxy).
import 'server-only';
import { type HomeTrack, HomeTrackSchema } from '@/lib/contracts/home-tracks';
import { isS3Configured, listObjectsPage, presignGetUrl } from '@/lib/music/s3-storage.server';

/** Prefisso usato dagli upload degli utenti: va ESCLUSO dai brani in evidenza della Home. */
const USER_UPLOAD_PREFIX = 'public-uploads/';
/** Estensioni audio riconosciute (il listing non riporta il content-type: si va per estensione). */
const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'm4b',
  'aac',
  'ogg',
  'oga',
  'opus',
  'wav',
  'flac',
  'webm',
  'weba',
]);
/** Massimo numero di brani in evidenza mostrati in Home. */
const MAX_HOME_TRACKS = 24;

/** La sezione è attiva solo se AWS S3 è configurato (regione, bucket, credenziali). */
export function isHomeTracksConfigured(): boolean {
  return isS3Configured();
}

function fileExtension(key: string): string {
  const base = key.slice(key.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True per una chiave S3 che è un brano in evidenza (audio, NON un upload utente). */
export function isHomeAudioKey(key: string): boolean {
  return !key.startsWith(USER_UPLOAD_PREFIX) && AUDIO_EXTENSIONS.has(fileExtension(key));
}

/** Titolo leggibile dal nome del file: toglie cartella ed estensione, separatori → spazi. */
function titleFromKey(key: string): string {
  const base = key.slice(key.lastIndexOf('/') + 1);
  let name = base.replace(/\.[^.]+$/, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // chiave non codificata: lascia com'è.
  }
  name = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!name) return 'Brano';
  // Se è tutto minuscolo (uno slug), rendi maiuscola l'iniziale; altrimenti rispetta il nome scelto.
  return name === name.toLowerCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/**
 * Elenca i brani in evidenza: tutti i file audio nel bucket S3 che NON sono upload degli utenti,
 * dal più recente. Non fa mai throw: qualsiasi problema (storage assente, API lenta) → lista vuota
 * (o quanto già raccolto), così la Home non si rompe mai. Lo streamUrl è un URL GET firmato.
 */
export async function listHomeTracks(): Promise<HomeTrack[]> {
  if (!isS3Configured()) return [];

  // ListObjectsV2 torna UNA pagina per volta (max 1000, ordinata per chiave). Gli upload degli
  // utenti vivono nello stesso bucket: si pagina con il token raccogliendo SOLO le chiavi audio in
  // evidenza (array piccolo anche con molti upload); un tetto di pagine + il timeout del listing
  // evitano scansioni illimitate. Se qualcosa si raccoglie prima di un errore, si mostra.
  const MAX_PAGES = 20;
  const found: { key: string; lastModified: Date | null }[] = [];
  try {
    let token: string | undefined;
    let page = 0;
    do {
      const result = await listObjectsPage(token);
      for (const obj of result.objects) {
        if (isHomeAudioKey(obj.key)) found.push({ key: obj.key, lastModified: obj.lastModified });
      }
      token = result.nextToken;
      page += 1;
    } while (token && page < MAX_PAGES);
  } catch {
    if (found.length === 0) return [];
  }

  try {
    const top = found
      .sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0))
      .slice(0, MAX_HOME_TRACKS);

    // Un URL GET firmato per ciascuno (firma locale, nessuna rete): il player lo riproduce diretto.
    const parsed = await Promise.all(
      top.map(async (obj) =>
        // Valida contro il contratto: un oggetto malformato viene scartato, non rompe la sezione.
        HomeTrackSchema.safeParse({
          id: obj.key,
          title: titleFromKey(obj.key),
          artist: null,
          streamUrl: await presignGetUrl(obj.key),
          durationSeconds: 0,
        }),
      ),
    );
    return parsed.flatMap((item) => (item.success ? [item.data] : []));
  } catch {
    return [];
  }
}
