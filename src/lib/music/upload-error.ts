// @polsia:user-owned — messaggio d'errore leggibile (italiano) per un fallimento di caricamento
// brano, con la causa reale quando è inattesa, così da diagnosticare senza aprire DevTools.
import { uploadErrorMessageIt } from '@/lib/music/recorder';
import { FileUploadError } from '@/modules/file-upload/client';

/**
 * Dà un messaggio per l'utente a partire dall'errore sollevato durante il caricamento:
 *  - errore del modulo upload (mint/PUT/confirm): messaggio italiano per codice; per i casi
 *    inattesi ('unknown') aggiunge il dettaglio del server (es. "not configured", HTTP dello
 *    storage, "Polsia could not be reached"), prezioso per capire DOVE fallisce;
 *  - errore della registrazione lato API (`apiFetch` lancia Error con `cause` = corpo della
 *    risposta e `message` col codice di stato): usa l'errore di campo se c'è, altrimenti il
 *    codice d'errore del server o lo stato HTTP.
 */
export function uploadFailureMessage(err: unknown): string {
  if (err instanceof FileUploadError) {
    const base = uploadErrorMessageIt(err.code);
    return err.code === 'unknown' && err.detail ? `${base} (${err.detail})` : base;
  }
  if (err instanceof Error) {
    const cause = err.cause as { errors?: Record<string, string>; error?: string } | undefined;
    if (cause?.errors?.fileKey) return cause.errors.fileKey;
    if (cause?.error) return `Caricamento non riuscito: ${cause.error}.`;
    return `Caricamento non riuscito. Riprova. (${err.message})`;
  }
  return 'Caricamento non riuscito. Riprova.';
}
