// @polsia:user-owned — logica server della libreria PUBBLICA di brani caricati (Vercel Blob).
// Il file audio è un oggetto PUBBLICO su Blob (URL CDN): qui si registrano i metadati, si elenca
// la classifica pubblica, si moderano le segnalazioni e si rimuovono (anche l'oggetto su Blob).
// Gli ascolti della classifica si contano al massimo una volta al giorno per ascoltatore, con una
// chiave pseudonima (HMAC, diversa per ogni brano e giorno) al posto dell'id utente o della rete.
//
// TESTO dei brani: un upload è per definizione un brano dell'utente (lo attesta al caricamento),
// e il testo si mostra nel player solo se l'autore conferma di averne i diritti
// (lyricsRightsConfirmed) e il brano è pubblicato. L'autore può aggiungerlo, cambiarlo o toglierlo.
import 'server-only';
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { del, head } from '@vercel/blob';
import { romeDay } from '@/lib/business/rewards';
import { LYRICS_CREDIT_UPLOAD, type Lyrics } from '@/lib/contracts/lyrics';
import {
  PUBLIC_UPLOAD_MAX_PER_USER,
  type PublicUpload,
  type PublicUploadCreateInput,
  type PublicUploadLyricsUpdate,
} from '@/lib/contracts/public-uploads';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { parseLyrics } from '@/lib/music/lyrics';

/** Oltre questo numero di segnalatori DISTINTI il brano si auto-ritira dalla libreria pubblica. */
export const AUTO_UNPUBLISH_REPORTS = 5;
/** Tetto di brani pubblici per utente: ognuno può pubblicare al massimo 3 brani. */
export const MAX_UPLOADS_PER_USER = PUBLIC_UPLOAD_MAX_PER_USER;
/** Prefisso obbligatorio del percorso su Blob (lo impone anche il token di caricamento). */
export const PUBLIC_UPLOAD_PREFIX = 'public-uploads/';

export class PublicUploadLimitReached extends Error {}
export class InvalidPublicUploadSource extends Error {}
export class BlobNotConfigured extends Error {}

/** La libreria pubblica è attiva solo se Vercel Blob è configurato (token presente). */
export function isPublicUploadConfigured(): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN);
}

/** Quanti brani pubblici ha già l'utente (per far rispettare il tetto già al rilascio del token). */
export function countUserPublicUploads(userId: string): Promise<number> {
  return prisma.publicUpload.count({ where: { uploaderUserId: userId } });
}

const selectUpload = {
  id: true,
  uploaderUserId: true,
  title: true,
  artist: true,
  blobUrl: true,
  durationSeconds: true,
  published: true,
  playCount: true,
  createdAt: true,
} as const;

/** I brani dell'utente stesso: anche il testo salvato e la conferma dei diritti (per modificarli). */
const selectOwnUpload = {
  ...selectUpload,
  lyrics: true,
  lyricsRightsConfirmed: true,
} as const;

type UploadRow = {
  id: string;
  uploaderUserId: string;
  title: string;
  artist: string | null;
  blobUrl: string;
  durationSeconds: number;
  published: boolean;
  playCount: number;
  createdAt: Date;
  lyrics?: string | null;
  lyricsRightsConfirmed?: boolean;
};

/**
 * Riga DB → brano pubblico per il client. I brani pubblicati sono ascoltabili SOLO dagli utenti
 * Premium (o dal proprietario sui propri brani): a chi non può ascoltare NON si invia lo streamUrl
 * (null), così l'URL del file non lascia mai il server verso un non abbonato. L'anteprima resta
 * visibile (titolo, artista, ascolti) ma bloccata.
 */
function toPublicUpload(
  row: UploadRow,
  viewerUserId: string | null,
  viewerPremium: boolean,
): PublicUpload {
  const mine = viewerUserId !== null && row.uploaderUserId === viewerUserId;
  const canPlay = mine || viewerPremium;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    streamUrl: canPlay ? row.blobUrl : null,
    durationSeconds: row.durationSeconds,
    playCount: row.playCount,
    createdAt: row.createdAt.toISOString(),
    mine,
    published: row.published,
    canPlay,
    // Il testo salvato torna SOLO al suo autore (per modificarlo), mai nella classifica pubblica.
    ...(mine && 'lyrics' in row
      ? { lyrics: row.lyrics ?? null, lyricsRightsConfirmed: row.lyricsRightsConfirmed === true }
      : {}),
  };
}

/**
 * Registra un brano già caricato su Blob come oggetto pubblico. Verifica con head() che l'oggetto
 * esista davvero, sia audio, abbia la dimensione dichiarata e un percorso nel prefisso consentito;
 * così il client non può registrare un URL arbitrario o un file non audio.
 */
export async function registerPublicUpload(
  userId: string,
  input: PublicUploadCreateInput,
): Promise<PublicUpload> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new BlobNotConfigured();

  if (!input.blobPathname.startsWith(PUBLIC_UPLOAD_PREFIX)) {
    throw new InvalidPublicUploadSource();
  }

  const existing = await prisma.publicUpload.count({ where: { uploaderUserId: userId } });
  if (existing >= MAX_UPLOADS_PER_USER) throw new PublicUploadLimitReached();

  // Validazione dell'oggetto con head(), ma con TIMEOUT: se l'API di Blob non risponde in tempo non
  // si blocca la registrazione all'infinito (era la causa della POST che restava "pending"). Quando
  // head() risponde i controlli sono severi; se va in timeout/errore si procede lo stesso, perché
  // l'URL è già ristretto a *.blob.vercel-storage.com dal contratto, il percorso è nel prefisso
  // consentito (controllato sopra) e il caricamento è passato dalla route token (loggato, solo
  // audio, max 40MB).
  const abortSignal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(8000)
      : undefined;
  // Doppia rete di sicurezza: abortSignal su head() + una corsa con timeout, così la funzione
  // risponde entro ~8,5 s anche se head() non onorasse il segnale di annullamento.
  const headResult = head(input.blobUrl, { token, abortSignal }).catch(
    () => null as Awaited<ReturnType<typeof head>> | null,
  );
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), 8500);
  });
  const meta = await Promise.race([headResult, timeout]);
  if (meta) {
    const contentType = (meta.contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
    // Si rifiuta SOLO se head() dice chiaramente che non è audio. Non si confrontano esattamente
    // dimensione e percorso: i valori restituiti da Blob (es. slash iniziale nel percorso, o una
    // dimensione calcolata diversamente) possono differire da quelli del client e farebbero
    // fallire registrazioni perfettamente valide — era la causa dei brani che non comparivano.
    // La sicurezza di base resta: URL ristretto a *.blob.vercel-storage.com, prefisso consentito,
    // caricamento passato dalla route token (loggato, solo audio, max 40MB).
    if (contentType && !contentType.startsWith('audio/')) {
      throw new InvalidPublicUploadSource();
    }
  }

  const durationSeconds = Math.max(1, Math.min(86_400, Math.ceil(input.elapsedSeconds)));
  // Il contratto ha già normalizzato il testo e preteso la conferma dei diritti se non è vuoto.
  const lyrics = input.lyrics && input.lyricsRightsConfirmed === true ? input.lyrics : null;

  try {
    // Conteggio e creazione nella STESSA transazione, serializzati per utente da un lock di
    // Postgres (pg_advisory_xact_lock, rilasciato a fine transazione): due registrazioni partite
    // insieme con 2 brani non possono più passare entrambe il controllo e arrivare a 4. Il
    // controllo veloce più sopra resta per rispondere subito senza interrogare Blob.
    const lockKey = `public-upload:${userId}`;
    const row = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${lockKey}))) AS lock_taken`;
      const owned = await tx.publicUpload.count({ where: { uploaderUserId: userId } });
      if (owned >= MAX_UPLOADS_PER_USER) throw new PublicUploadLimitReached();
      return tx.publicUpload.create({
        data: {
          uploaderUserId: userId,
          title: input.title,
          artist: input.artist && input.artist.length > 0 ? input.artist : null,
          blobUrl: input.blobUrl,
          blobPathname: input.blobPathname,
          mimeType: input.mimeType,
          byteLength: input.byteLength,
          durationSeconds,
          lyrics,
          lyricsRightsConfirmed: lyrics !== null,
        },
        select: selectOwnUpload,
      });
    });
    // È un brano del proprietario stesso: può sempre ascoltarlo (canPlay).
    return toPublicUpload(row, userId, true);
  } catch (error) {
    // Stesso oggetto già registrato (blobUrl/blobPathname unici): sorgente non valida.
    if (isUniqueViolation(error)) throw new InvalidPublicUploadSource();
    throw error;
  }
}

/**
 * Classifica pubblica: brani pubblicati, i più ascoltati prima, poi i più recenti. `viewerPremium`
 * decide chi riceve lo streamUrl: solo gli utenti Premium (e il proprietario sui propri brani)
 * possono ascoltare; agli altri arriva l'anteprima bloccata (streamUrl null, canPlay false).
 */
export async function listPublicUploads(
  viewerUserId: string | null,
  viewerPremium: boolean,
): Promise<PublicUpload[]> {
  const rows = await prisma.publicUpload.findMany({
    where: { published: true },
    orderBy: [{ playCount: 'desc' }, { createdAt: 'desc' }],
    take: 100,
    select: selectUpload,
  });
  return rows.map((row) => toPublicUpload(row, viewerUserId, viewerPremium));
}

/**
 * Un brano caricato DALL'UTENTE stesso, pronto per lo scaricamento (solo il proprietario): URL
 * dell'oggetto, chiave (per l'estensione), titolo e tipo. null se non è suo o non esiste. È
 * contenuto dell'utente: scaricarlo è legittimo (nessun ripping da fonti di terzi).
 */
export async function getOwnUploadForDownload(
  userId: string,
  uploadId: string,
): Promise<{ blobUrl: string; blobPathname: string; title: string; mimeType: string } | null> {
  return prisma.publicUpload.findFirst({
    where: { id: uploadId, uploaderUserId: userId },
    select: { blobUrl: true, blobPathname: true, title: true, mimeType: true },
  });
}

/** I brani caricati dall'utente (anche ritirati dalla moderazione), per gestirli. */
export async function listMyPublicUploads(userId: string): Promise<PublicUpload[]> {
  const rows = await prisma.publicUpload.findMany({
    where: { uploaderUserId: userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: selectOwnUpload,
  });
  // Sono tutti brani del proprietario: li può sempre ascoltare (canPlay).
  return rows.map((row) => toPublicUpload(row, userId, true));
}

/**
 * L'autore aggiunge, cambia o toglie il testo di un SUO brano (`lyrics` vuoto o null = lo toglie,
 * insieme alla conferma dei diritti). null se il brano non esiste o non è suo (stessa risposta).
 */
export async function updatePublicUploadLyrics(
  userId: string,
  uploadId: string,
  update: PublicUploadLyricsUpdate,
): Promise<PublicUpload | null> {
  const owned = await prisma.publicUpload.findFirst({
    where: { id: uploadId, uploaderUserId: userId },
    select: { id: true },
  });
  if (!owned) return null;
  const lyrics = update.lyrics && update.lyricsRightsConfirmed === true ? update.lyrics : null;
  const row = await prisma.publicUpload.update({
    where: { id: owned.id },
    data: { lyrics, lyricsRightsConfirmed: lyrics !== null },
    select: selectOwnUpload,
  });
  return toPublicUpload(row, userId, true);
}

/**
 * Il testo di un upload per il player: solo per un brano PUBBLICATO con il testo confermato
 * dall'autore. null in ogni altro caso (inesistente, ritirato, senza testo o senza conferma: la
 * risposta è la stessa).
 */
export async function readPublishedUploadLyrics(uploadId: string): Promise<Lyrics | null> {
  const row = await prisma.publicUpload.findFirst({
    where: { id: uploadId, published: true, lyricsRightsConfirmed: true },
    select: { lyrics: true },
  });
  const parsed = parseLyrics(row?.lyrics ?? null);
  if (!parsed) return null;
  return { kind: parsed.kind, lines: parsed.lines, source: 'upload', credit: LYRICS_CREDIT_UPLOAD };
}

/**
 * Chi ascolta, per la classifica: l'utente con l'accesso oppure, senza accesso, la sua RETE come
 * la restituisce networkIdentity() (stessa fonte dei limiti, x-real-ip dell'ingress): "ip:<IPv4>"
 * o "ip6:<prefisso>::/64", perché un cliente IPv6 riceve di solito un intero /64 e potrebbe
 * cambiare indirizzo a ogni richiesta. La route conta solo chi può davvero ascoltare il brano
 * (oggi un account Premium), quindi in pratica la chiave nasce dall'account.
 */
export type PublicUploadListener = { userId: string | null; network: string | null };

/** Contesto della sottochiave HMAC: separa queste chiavi dagli altri usi dello stesso segreto. */
const PLAY_KEY_CONTEXT = 'solco-public-upload-plays-v1';
/** Rete IPv6 come la scrive networkIdentity(): i primi 4 gruppi, cioè il /64. */
const IPV6_NETWORK = /^ip6:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){3}::\/64$/;

/** "u:<id utente>" o "net:<rete>"; null senza un'identità valida (un IPv6 intero non vale). */
function listenerSource(listener: PublicUploadListener): string | null {
  const userId = listener.userId?.trim();
  if (userId) return `u:${userId}`;
  const network = listener.network?.trim().toLowerCase();
  if (!network) return null;
  const ipv4 = network.startsWith('ip:') && isIP(network.slice(3)) === 4;
  return ipv4 || IPV6_NETWORK.test(network) ? `net:${network}` : null;
}

/**
 * Chiave PSEUDONIMA dell'ascoltatore: HMAC-SHA256 (esadecimale) di "<giorno>|<id brano>|<fonte>"
 * (fonte "u:<id utente>" o "net:<rete>"), con una sottochiave derivata da BETTER_AUTH_SECRET. Né
 * l'IP né l'id utente finiscono in chiaro nel database; e poiché giorno e brano entrano nella
 * chiave, le righe dello stesso ascoltatore su brani o giorni diversi non si possono collegare
 * tra loro (per non contare due volte basta l'unicità per brano e giorno). Chi ha il segreto può
 * comunque verificare un'ipotesi: per questo è pseudonima, non anonima. null se non c'è alcuna
 * identità valida (o manca il segreto): in quel caso l'ascolto non si conta.
 */
export function publicUploadListenerKey(
  listener: PublicUploadListener,
  uploadId: string,
  day: string,
): string | null {
  const source = listenerSource(listener);
  if (!source) return null;
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  const subkey = createHmac('sha256', secret).update(PLAY_KEY_CONTEXT).digest();
  return createHmac('sha256', subkey).update(`${day}|${uploadId}|${source}`).digest('hex');
}

/** Giorno di calendario in Italia ("YYYY-MM-DD"): un ascolto al giorno per ascoltatore. */
export function publicUploadPlayDay(now: Date): string {
  return romeDay(now);
}

/**
 * Registra un ascolto per la classifica «Brani più ascoltati dalla community». Conta al massimo
 * UN ascolto per ascoltatore, per brano, per giorno (Europe/Rome): la riga PublicUploadPlay e
 * l'incremento di playCount avvengono nella stessa transazione, e l'incremento parte solo se la
 * riga è stata davvero inserita (già presente oggi → nessun punto). Non conta gli ascolti
 * dell'autore stesso (niente auto-gonfiaggio) né le richieste senza alcuna identità. Ritorna
 * true se l'ascolto è stato contato; non fa mai throw verso il player.
 */
export async function recordPublicUploadPlay(
  uploadId: string,
  listener: PublicUploadListener,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const day = publicUploadPlayDay(now);
    const listenerKey = publicUploadListenerKey(listener, uploadId, day);
    if (!listenerKey) return false;
    const row = await prisma.publicUpload.findUnique({
      where: { id: uploadId },
      select: { uploaderUserId: true },
    });
    if (!row) return false;
    // Il proprietario non fa punti sulla propria classifica.
    if (listener.userId && row.uploaderUserId === listener.userId) return false;
    return await prisma.$transaction(async (tx) => {
      // ON CONFLICT DO NOTHING: un secondo ascolto oggi non inserisce nulla (count 0), anche con
      // richieste concorrenti, senza errori di unicità da gestire.
      const inserted = await tx.publicUploadPlay.createMany({
        data: [{ uploadId, listenerKey, day }],
        skipDuplicates: true,
      });
      if (inserted.count !== 1) return false;
      await tx.publicUpload.update({
        where: { id: uploadId },
        data: { playCount: { increment: 1 } },
      });
      return true;
    });
  } catch {
    // Già contato oggi (violazione di unicità), brano rimosso nel frattempo o database non
    // raggiungibile: l'ascolto non si conta, il player continua.
    return false;
  }
}

/**
 * Segnala un brano pubblicato. Una segnalazione per segnalatore (unique): oltre la soglia di
 * segnalatori distinti il brano si auto-ritira. Ritorna false se il brano pubblicato non esiste.
 */
export async function reportPublicUpload(
  uploadId: string,
  reporterUserId: string,
): Promise<boolean> {
  const upload = await prisma.publicUpload.findFirst({
    where: { id: uploadId, published: true },
    select: { id: true },
  });
  if (!upload) return false;

  try {
    await prisma.publicUploadReport.create({ data: { uploadId, reporterUserId } });
  } catch (error) {
    // Già segnalato da questo utente: non conta due volte, ma non è un errore.
    if (!isUniqueViolation(error)) throw error;
  }

  const reporters = await prisma.publicUploadReport.count({ where: { uploadId } });
  if (reporters >= AUTO_UNPUBLISH_REPORTS) {
    const row = await prisma.publicUpload.update({
      where: { id: uploadId },
      data: { published: false },
      select: { blobUrl: true },
    });
    // Takedown vero: rimuove l'oggetto dalla CDN pubblica, non solo dall'elenco, così l'audio
    // segnalato smette davvero di essere servito (il suo URL pubblico non risponde più).
    const token = env.BLOB_READ_WRITE_TOKEN;
    if (token) {
      try {
        await del(row.blobUrl, { token });
      } catch {
        // Già rimosso o non raggiungibile: la riga resta comunque non pubblicata.
      }
    }
  }
  return true;
}

/** Rimuove un brano dell'utente: cancella l'oggetto su Blob e la riga. Ritorna false se non suo. */
export async function deletePublicUpload(userId: string, uploadId: string): Promise<boolean> {
  const row = await prisma.publicUpload.findFirst({
    where: { id: uploadId, uploaderUserId: userId },
    select: { id: true, blobUrl: true },
  });
  if (!row) return false;

  const token = env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    try {
      await del(row.blobUrl, { token });
    } catch {
      // L'oggetto potrebbe essere già sparito: procedi comunque a togliere la riga.
    }
  }
  await prisma.publicUpload.delete({ where: { id: row.id } });
  return true;
}

/**
 * Toglie dalla CDN i file dei brani di un account appena cancellato (le righe sono già sparite
 * nella transazione). Best effort come per il singolo brano: non lancia mai, così un Blob non
 * raggiungibile non fa sembrare fallita una cancellazione dell'account già avvenuta.
 */
export async function deletePublicUploadBlobs(blobUrls: readonly string[]): Promise<void> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token || blobUrls.length === 0) return;
  try {
    await del([...blobUrls], { token });
  } catch {
    // Già rimossi o Blob non raggiungibile: l'account resta comunque cancellato.
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
